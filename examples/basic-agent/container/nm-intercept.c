/**
 * nm-intercept.c — LD_PRELOAD library that intercepts mkdir/mkdirat to
 * automatically bind-mount local disk over node_modules directories created
 * under a FUSE mount.
 *
 * Why: FUSE (tigrisfs) cannot preserve POSIX execute bits needed by
 * node_modules/.bin/ shims, and high-throughput parallel writes (npm install)
 * cause TAR_ENTRY_ERROR races. Intercepting at the syscall level eliminates
 * the polling race window — the bind-mount happens before mkdir returns,
 * so the caller writes to local disk from the very first file.
 *
 * Compile:
 *   gcc -shared -fPIC -o /usr/local/lib/nm-intercept.so nm-intercept.c -ldl
 *
 * Usage:
 *   LD_PRELOAD=/usr/local/lib/nm-intercept.so NM_INTERCEPT_MOUNT=/mnt/r2 <command>
 *
 * Environment:
 *   NM_INTERCEPT_MOUNT  — FUSE mount prefix to watch (default: /mnt/r2)
 *   NM_INTERCEPT_BASE   — Local backing directory (default: /opt/gia/nm)
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
/* MS_BIND may not be defined in musl — define it if missing */
#ifndef MS_BIND
#define MS_BIND 4096
#endif
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* Original libc functions */
static int (*real_mkdir)(const char *, mode_t) = NULL;
static int (*real_mkdirat)(int, const char *, mode_t) = NULL;

/* Configuration (read once from env) */
static const char *mount_prefix = NULL;
static size_t mount_prefix_len = 0;
static const char *nm_base = NULL;
static int initialized = 0;

static void ensure_init(void) {
    if (initialized) return;
    initialized = 1;

    real_mkdir = dlsym(RTLD_NEXT, "mkdir");
    real_mkdirat = dlsym(RTLD_NEXT, "mkdirat");

    mount_prefix = getenv("NM_INTERCEPT_MOUNT");
    if (!mount_prefix) mount_prefix = "/mnt/r2";
    mount_prefix_len = strlen(mount_prefix);

    nm_base = getenv("NM_INTERCEPT_BASE");
    if (!nm_base) nm_base = "/opt/gia/nm";
}

/**
 * Simple DJB2 hash of a string, returned as hex for directory naming.
 */
static void path_hash(const char *str, char *out, size_t out_len) {
    unsigned long hash = 5381;
    int c;
    while ((c = *str++))
        hash = ((hash << 5) + hash) + c;
    snprintf(out, out_len, "%lx", hash);
}

/**
 * Check if a path is a node_modules directory under the FUSE mount.
 * Returns 1 if it should be intercepted.
 */
static int should_intercept(const char *path) {
    if (!path) return 0;
    /* Must be under the FUSE mount prefix */
    if (strncmp(path, mount_prefix, mount_prefix_len) != 0) return 0;

    /* Basename must be "node_modules" */
    const char *basename = strrchr(path, '/');
    if (!basename) return 0;
    basename++; /* skip the slash */
    if (strcmp(basename, "node_modules") != 0) return 0;

    /* Don't intercept nested node_modules (inside an already-mounted one) */
    /* Count occurrences of /node_modules/ in the path */
    int count = 0;
    const char *search = path;
    while ((search = strstr(search, "/node_modules")) != NULL) {
        count++;
        search += 13; /* strlen("/node_modules") */
    }
    /* Only intercept the first level (path ends with node_modules, count == 1) */
    if (count > 1) return 0;

    return 1;
}

/**
 * Perform the bind-mount: create local backing dir, mount over the FUSE path.
 */
static void do_bind_mount(const char *nm_path) {
    char hash[32];
    char local_dir[PATH_MAX];

    /* Hash the relative path for a deterministic local directory name */
    const char *rel = nm_path + mount_prefix_len;
    if (*rel == '/') rel++;
    path_hash(rel, hash, sizeof(hash));
    snprintf(local_dir, sizeof(local_dir), "%s/%s", nm_base, hash);

    /* Create local backing directory */
    real_mkdir(local_dir, 0755);
    /* Fix ownership (gia user — uid/gid typically 1000) */
    chown(local_dir, 1000, 1000);

    /* Bind-mount local disk over the FUSE path */
    if (mount(local_dir, nm_path, NULL, MS_BIND, NULL) == 0) {
        fprintf(stderr, "[nm-intercept] Mounted %s -> %s\n", nm_path, local_dir);
        /* Ensure the mounted dir is writable by gia */
        chown(nm_path, 1000, 1000);
    } else {
        fprintf(stderr, "[nm-intercept] mount failed for %s: %s\n",
                nm_path, strerror(errno));
    }
}

int mkdir(const char *pathname, mode_t mode) {
    ensure_init();

    int ret = real_mkdir(pathname, mode);
    if (ret != 0) return ret;

    /* Resolve to absolute path for reliable prefix matching */
    char resolved[PATH_MAX];
    if (realpath(pathname, resolved) && should_intercept(resolved)) {
        do_bind_mount(resolved);
    }

    return ret;
}

int mkdirat(int dirfd, const char *pathname, mode_t mode) {
    ensure_init();

    int ret = real_mkdirat(dirfd, pathname, mode);
    if (ret != 0) return ret;

    /* Resolve the full path */
    char resolved[PATH_MAX];
    if (pathname[0] == '/') {
        /* Absolute path */
        if (realpath(pathname, resolved) && should_intercept(resolved)) {
            do_bind_mount(resolved);
        }
    } else if (dirfd == AT_FDCWD) {
        /* Relative to cwd */
        char cwd[PATH_MAX];
        if (getcwd(cwd, sizeof(cwd))) {
            char full[PATH_MAX];
            snprintf(full, sizeof(full), "%s/%s", cwd, pathname);
            if (realpath(full, resolved) && should_intercept(resolved)) {
                do_bind_mount(resolved);
            }
        }
    } else {
        /* Relative to dirfd — resolve via /proc/self/fd */
        char fd_path[64];
        char dir_resolved[PATH_MAX];
        snprintf(fd_path, sizeof(fd_path), "/proc/self/fd/%d", dirfd);
        ssize_t len = readlink(fd_path, dir_resolved, sizeof(dir_resolved) - 1);
        if (len > 0) {
            dir_resolved[len] = '\0';
            char full[PATH_MAX];
            snprintf(full, sizeof(full), "%s/%s", dir_resolved, pathname);
            if (realpath(full, resolved) && should_intercept(resolved)) {
                do_bind_mount(resolved);
            }
        }
    }

    return ret;
}

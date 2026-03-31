/**
 * nm-mount-helper.c — Setuid root helper for nm-intercept.
 *
 * nm-intercept runs inside the unprivileged sandbox user's process and
 * cannot call mount() directly. This small setuid-root binary performs
 * the bind-mount on behalf of nm-intercept, which fork+execs it.
 *
 * Usage:  nm-mount-helper <node_modules_path>
 *
 * Environment:
 *   NM_INTERCEPT_MOUNT  — FUSE mount prefix (default: /mnt/r2)
 *   NM_INTERCEPT_BASE   — Local backing directory (default: /opt/sandbox/nm)
 *
 * Security: Validates that the path is a node_modules directory under
 * the expected mount prefix before performing any mount operation.
 *
 * Compile:
 *   gcc -o /usr/local/bin/nm-mount-helper nm-mount-helper.c
 *   chmod u+s /usr/local/bin/nm-mount-helper
 */

#include <errno.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef MS_BIND
#define MS_BIND 4096
#endif

static void path_hash(const char *str, char *out, size_t out_len) {
    unsigned long hash = 5381;
    int c;
    while ((c = *str++))
        hash = ((hash << 5) + hash) + c;
    snprintf(out, out_len, "%lx", hash);
}

static int validate_path(const char *path, const char *prefix, size_t prefix_len) {
    /* Must be under the mount prefix */
    if (strncmp(path, prefix, prefix_len) != 0) return 0;

    /* Basename must be "node_modules" */
    const char *basename = strrchr(path, '/');
    if (!basename) return 0;
    basename++;
    if (strcmp(basename, "node_modules") != 0) return 0;

    /* Only top-level node_modules (no nesting) */
    int count = 0;
    const char *search = path;
    while ((search = strstr(search, "/node_modules")) != NULL) {
        count++;
        search += 13;
    }
    if (count > 1) return 0;

    return 1;
}

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "[nm-mount-helper] Usage: nm-mount-helper <path>\n");
        return 1;
    }

    const char *nm_path = argv[1];

    /* Resolve to absolute path */
    char resolved[PATH_MAX];
    if (!realpath(nm_path, resolved)) {
        fprintf(stderr, "[nm-mount-helper] Cannot resolve path: %s\n", nm_path);
        return 1;
    }

    const char *mount_prefix = getenv("NM_INTERCEPT_MOUNT");
    if (!mount_prefix) mount_prefix = "/mnt/r2";
    size_t mount_prefix_len = strlen(mount_prefix);

    const char *nm_base = getenv("NM_INTERCEPT_BASE");
    if (!nm_base) nm_base = "/opt/sandbox/nm";

    /* Validate the path strictly */
    if (!validate_path(resolved, mount_prefix, mount_prefix_len)) {
        fprintf(stderr, "[nm-mount-helper] Rejected: %s (not a valid node_modules path)\n", resolved);
        return 1;
    }

    /* Check if already mounted */
    FILE *mounts = fopen("/proc/mounts", "r");
    if (mounts) {
        char line[4096];
        while (fgets(line, sizeof(line), mounts)) {
            if (strstr(line, resolved)) {
                fclose(mounts);
                /* Already mounted — success (idempotent) */
                return 0;
            }
        }
        fclose(mounts);
    }

    /* Compute backing directory */
    char hash[32];
    const char *rel = resolved + mount_prefix_len;
    if (*rel == '/') rel++;
    path_hash(rel, hash, sizeof(hash));

    char local_dir[PATH_MAX];
    snprintf(local_dir, sizeof(local_dir), "%s/%s", nm_base, hash);

    /* Resolve sandbox user uid/gid (don't hardcode — varies by container) */
    uid_t owner_uid = 1000;
    gid_t owner_gid = 1000;
    struct passwd *pw = getpwnam("sandbox");
    if (pw) {
        owner_uid = pw->pw_uid;
        owner_gid = pw->pw_gid;
    }

    /* Create local backing directory */
    mkdir(local_dir, 0755);
    chown(local_dir, owner_uid, owner_gid);

    /* Bind-mount local disk over the FUSE/workspace path */
    if (mount(local_dir, resolved, NULL, MS_BIND, NULL) != 0) {
        fprintf(stderr, "[nm-mount-helper] mount failed for %s: %s\n",
                resolved, strerror(errno));
        return 1;
    }

    /* Fix ownership on mount point */
    chown(resolved, owner_uid, owner_gid);

    fprintf(stderr, "[nm-mount-helper] Mounted %s -> %s\n", resolved, local_dir);
    return 0;
}

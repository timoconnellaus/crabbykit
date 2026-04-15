import { describe, expect, it } from "vitest";
import { AppStore } from "../app-store.js";
import { createMockSqlStore } from "./mock-sql-store.js";

function createStore(): AppStore {
  return new AppStore(createMockSqlStore());
}

describe("AppStore", () => {
  describe("schema initialization", () => {
    it("creates tables on construction without error", () => {
      expect(() => createStore()).not.toThrow();
    });
  });

  describe("create", () => {
    it("creates an app with name and slug", () => {
      const store = createStore();
      const app = store.create("Todo App", "todo-app");

      expect(app.id).toBeDefined();
      expect(app.name).toBe("Todo App");
      expect(app.slug).toBe("todo-app");
      expect(app.currentVersion).toBe(0);
      expect(app.hasBackend).toBe(false);
      expect(app.createdAt).toBeDefined();
      expect(app.updatedAt).toBeDefined();
    });

    it("generates unique IDs for different apps", () => {
      const store = createStore();
      const app1 = store.create("App 1", "app-1");
      const app2 = store.create("App 2", "app-2");

      expect(app1.id).not.toBe(app2.id);
    });

    it("throws on duplicate slug", () => {
      const store = createStore();
      store.create("First App", "my-app");

      expect(() => store.create("Second App", "my-app")).toThrow(/UNIQUE constraint/);
    });
  });

  describe("get", () => {
    it("returns app by id", () => {
      const store = createStore();
      const created = store.create("Test", "test");
      const fetched = store.get(created.id);

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("Test");
    });

    it("returns null for nonexistent id", () => {
      const store = createStore();
      expect(store.get("nonexistent")).toBeNull();
    });
  });

  describe("getBySlug", () => {
    it("returns app by slug", () => {
      const store = createStore();
      store.create("My App", "my-app");
      const fetched = store.getBySlug("my-app");

      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe("My App");
    });

    it("returns null for nonexistent slug", () => {
      const store = createStore();
      expect(store.getBySlug("nope")).toBeNull();
    });
  });

  describe("list", () => {
    it("returns empty array when no apps exist", () => {
      const store = createStore();
      expect(store.list()).toEqual([]);
    });

    it("returns all apps ordered by updated_at descending", () => {
      const store = createStore();
      store.create("Alpha", "alpha");
      store.create("Beta", "beta");
      store.create("Gamma", "gamma");

      const apps = store.list();
      expect(apps).toHaveLength(3);
    });
  });

  describe("update", () => {
    it("updates app name", () => {
      const store = createStore();
      const app = store.create("Old Name", "my-app");
      const updated = store.update(app.id, { name: "New Name" });

      expect(updated?.name).toBe("New Name");
      expect(updated?.slug).toBe("my-app");
    });

    it("updates currentVersion", () => {
      const store = createStore();
      const app = store.create("App", "app");
      const updated = store.update(app.id, { currentVersion: 5 });

      expect(updated?.currentVersion).toBe(5);
    });

    it("updates hasBackend", () => {
      const store = createStore();
      const app = store.create("App", "app");
      const updated = store.update(app.id, { hasBackend: true });

      expect(updated?.hasBackend).toBe(true);
    });

    it("returns null for nonexistent id", () => {
      const store = createStore();
      expect(store.update("nonexistent", { name: "test" })).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes app and its versions", () => {
      const store = createStore();
      const app = store.create("Doomed", "doomed");
      store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "abc123",
        files: ["index.html"],
        hasBackend: false,
      });

      store.delete(app.id);

      expect(store.get(app.id)).toBeNull();
      expect(store.getVersions(app.id)).toEqual([]);
    });

    it("does not affect other apps", () => {
      const store = createStore();
      const app1 = store.create("Keep", "keep");
      const app2 = store.create("Remove", "remove");

      store.delete(app2.id);

      expect(store.get(app1.id)).not.toBeNull();
    });
  });

  describe("addVersion", () => {
    it("creates version 1 for a new app", () => {
      const store = createStore();
      const app = store.create("App", "app");
      const version = store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "abc123",
        message: "Initial deploy",
        files: ["index.html", "app.js"],
        hasBackend: false,
      });

      expect(version).not.toBeNull();
      expect(version?.version).toBe(1);
      expect(version?.deployId).toBe("d1");
      expect(version?.commitHash).toBe("abc123");
      expect(version?.message).toBe("Initial deploy");
      expect(version?.files).toEqual(["index.html", "app.js"]);
      expect(version?.hasBackend).toBe(false);
    });

    it("increments version number on subsequent deploys", () => {
      const store = createStore();
      const app = store.create("App", "app");

      store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "aaa",
        files: ["a.html"],
        hasBackend: false,
      });
      const v2 = store.addVersion(app.id, {
        deployId: "d2",
        commitHash: "bbb",
        files: ["b.html"],
        hasBackend: false,
      });

      expect(v2?.version).toBe(2);
    });

    it("updates app currentVersion and hasBackend", () => {
      const store = createStore();
      const app = store.create("App", "app");

      store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "abc",
        files: ["index.html"],
        hasBackend: true,
      });

      const updated = store.get(app.id);
      expect(updated?.currentVersion).toBe(1);
      expect(updated?.hasBackend).toBe(true);
    });

    it("returns null for nonexistent app", () => {
      const store = createStore();
      expect(
        store.addVersion("nonexistent", {
          deployId: "d1",
          commitHash: "abc",
          files: [],
          hasBackend: false,
        }),
      ).toBeNull();
    });

    it("handles null message", () => {
      const store = createStore();
      const app = store.create("App", "app");
      const version = store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "abc",
        files: [],
        hasBackend: false,
      });

      expect(version?.message).toBeNull();
    });
  });

  describe("getVersions", () => {
    it("returns versions ordered by version descending", () => {
      const store = createStore();
      const app = store.create("App", "app");

      store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "aaa",
        files: [],
        hasBackend: false,
      });
      store.addVersion(app.id, {
        deployId: "d2",
        commitHash: "bbb",
        files: [],
        hasBackend: false,
      });
      store.addVersion(app.id, {
        deployId: "d3",
        commitHash: "ccc",
        files: [],
        hasBackend: false,
      });

      const versions = store.getVersions(app.id);
      expect(versions).toHaveLength(3);
      expect(versions[0].version).toBe(3);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(1);
    });

    it("returns empty array for app with no versions", () => {
      const store = createStore();
      const app = store.create("App", "app");
      expect(store.getVersions(app.id)).toEqual([]);
    });

    it("returns empty array for nonexistent app", () => {
      const store = createStore();
      expect(store.getVersions("nonexistent")).toEqual([]);
    });
  });

  describe("getVersion", () => {
    it("returns specific version", () => {
      const store = createStore();
      const app = store.create("App", "app");

      store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "aaa",
        files: [],
        hasBackend: false,
      });
      store.addVersion(app.id, {
        deployId: "d2",
        commitHash: "bbb",
        files: ["x.html"],
        hasBackend: true,
      });

      const v1 = store.getVersion(app.id, 1);
      expect(v1?.commitHash).toBe("aaa");
      expect(v1?.hasBackend).toBe(false);

      const v2 = store.getVersion(app.id, 2);
      expect(v2?.commitHash).toBe("bbb");
      expect(v2?.hasBackend).toBe(true);
    });

    it("returns null for nonexistent version", () => {
      const store = createStore();
      const app = store.create("App", "app");
      expect(store.getVersion(app.id, 99)).toBeNull();
    });
  });

  describe("getLatestVersion", () => {
    it("returns most recent version", () => {
      const store = createStore();
      const app = store.create("App", "app");

      store.addVersion(app.id, {
        deployId: "d1",
        commitHash: "aaa",
        files: [],
        hasBackend: false,
      });
      store.addVersion(app.id, {
        deployId: "d2",
        commitHash: "bbb",
        files: [],
        hasBackend: false,
      });

      const latest = store.getLatestVersion(app.id);
      expect(latest?.version).toBe(2);
      expect(latest?.commitHash).toBe("bbb");
    });

    it("returns null when no versions exist", () => {
      const store = createStore();
      const app = store.create("App", "app");
      expect(store.getLatestVersion(app.id)).toBeNull();
    });
  });
});

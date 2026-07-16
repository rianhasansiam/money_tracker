import { describe, expect, it, vi } from "vitest";
import {
  type AdminBootstrapRepository,
  BootstrapAdminConfigurationError,
  bootstrapAdmin,
  parseBootstrapAdminEmail,
} from "@/lib/admin-bootstrap";

describe("administrator bootstrap", () => {
  it("fails before repository access when the configured identity is missing", async () => {
    const repository: AdminBootstrapRepository = {
      ensureAdmin: vi.fn(),
    };

    await expect(bootstrapAdmin(repository, undefined)).rejects.toBeInstanceOf(
      BootstrapAdminConfigurationError,
    );
    expect(repository.ensureAdmin).not.toHaveBeenCalled();
  });

  it.each(["", "not-an-email", "admin@", "@example.com"])(
    "rejects invalid configured identity %j",
    (configuredEmail) => {
      expect(() => parseBootstrapAdminEmail(configuredEmail)).toThrow(
        BootstrapAdminConfigurationError,
      );
    },
  );

  it("canonicalizes the configured identity before repository access", async () => {
    const repository: AdminBootstrapRepository = {
      ensureAdmin: vi
        .fn<AdminBootstrapRepository["ensureAdmin"]>()
        .mockResolvedValue({ status: "unchanged" }),
    };

    await bootstrapAdmin(repository, "  Intended.Admin@Example.COM  ");

    expect(repository.ensureAdmin).toHaveBeenCalledWith(
      "intended.admin@example.com",
    );
  });

  it("creates once and remains unchanged on repeated execution", async () => {
    const administrators = new Set<string>();
    const repository: AdminBootstrapRepository = {
      async ensureAdmin(canonicalEmail) {
        if (administrators.has(canonicalEmail)) {
          return {
            status: "unchanged",
          };
        }

        administrators.add(canonicalEmail);

        return {
          status: "created",
        };
      },
    };

    const first = await bootstrapAdmin(repository, "admin@example.com");
    const repeated = await bootstrapAdmin(repository, "ADMIN@example.com");

    expect(first.status).toBe("created");
    expect(repeated.status).toBe("unchanged");
    expect(administrators).toEqual(new Set(["admin@example.com"]));
  });
});

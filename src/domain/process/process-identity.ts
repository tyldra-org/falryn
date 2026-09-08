/** Host-probed process birth evidence. A PID alone cannot authorize recovery or control. */
import { z } from "zod";

export const processBirthIdentitySchema = z.strictObject({
  platform: z.enum(["linux", "darwin"]),
  pid: z.int().positive(),
  /** Includes boot identity as well as the platform process start counter. */
  birth: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9._:-]+$/),
});
export type ProcessBirthIdentity = z.infer<typeof processBirthIdentitySchema>;

export type ProcessIdentityProbe =
  | { readonly kind: "present"; readonly identity: ProcessBirthIdentity }
  | { readonly kind: "vanished" }
  | { readonly kind: "unavailable" };
export type ProcessIdentityPort = {
  inspect(pid: number): Promise<ProcessIdentityProbe>;
};

export function sameProcessBirth(left: ProcessBirthIdentity, right: ProcessBirthIdentity): boolean {
  return left.platform === right.platform && left.pid === right.pid && left.birth === right.birth;
}

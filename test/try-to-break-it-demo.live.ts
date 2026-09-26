import { expect } from "chai";
import { spawn } from "node:child_process";
import { isWeb3ApiGeoBlocked } from "../scripts/lib/local-fork.js";

// Same pattern as test/chaos-fork.live.ts: spawns the real judge-facing
// command (`npm run try-to-break-it`) as a subprocess and asserts on its
// actual stdout, rather than importing its internals - this is what
// actually caught the real bug in the first version of this script
// (settling with the quote instead of the real ERC-20 Transfer amount,
// friction-log C17's exact mistake), which a test calling the internals
// directly could easily have missed by reusing the same wrong value.
describe("try-to-break-it-demo.ts (live, real subprocess, the actual demo-facing command)", function () {
  this.timeout(180_000);

  it("bypasses the mandate for real, then gets caught for real by verify.ts's reconcile()", async function () {
    let output: { stdout: string; code: number | null };
    try {
      output = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
        const child = spawn("npx", ["tsx", "scripts/try-to-break-it-demo.ts"], {
          cwd: new URL("..", import.meta.url).pathname,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`try-to-break-it-demo.ts exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
            return;
          }
          resolve({ stdout, code });
        });
      });
    } catch (err) {
      if (isWeb3ApiGeoBlocked(err)) return this.skip();
      throw err;
    }

    expect(output.stdout).to.include("Real Covenant deployed at 0x");
    expect(output.stdout).to.match(/settled with the real swap hash and real received amount: 0x[0-9a-f]{64}/);
    expect(output.stdout).to.match(/bypass swap went through with no commit: 0x[0-9a-f]{64}/);
    expect(output.stdout).to.match(/CAUGHT: UNMATCHED_TRADE on tx 0x[0-9a-f]{64}/);
    // The one honest trade matched, the bypass didn't get counted as a
    // false positive against it.
    expect(output.stdout).to.include("Honest trades stayed clean: 1 matched, 0 false positives among them.");
    expect(output.stdout).to.not.include("FAILED TO INDEPENDENTLY VERIFY");
  });
});

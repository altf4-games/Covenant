import { expect } from "chai";
import { spawn } from "node:child_process";

// Spawns the real scripts/chaos-fork.ts as a subprocess - the exact command
// a judge runs (`npm run chaos-fork`) - and asserts on its actual stdout,
// rather than reimplementing or importing its internals. This is the only
// way to actually prove the judge-facing command produces what the README
// claims it does: a test that imports chaos-fork's functions and calls them
// directly would not have caught the real NONCE_EXPIRED bug this script hit
// the first time it was actually run end to end (see README's "Tests, and
// what they caught").
describe("chaos-fork.ts (live, real subprocess, the actual judge-facing command)", function () {
  this.timeout(120_000);

  it("deliberately trips the guard on real deployed bytecode and reports every real decision", async function () {
    const output = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
      const child = spawn("npx", ["tsx", "scripts/chaos-fork.ts"], {
        cwd: new URL("..", import.meta.url).pathname,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`chaos-fork.ts exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
        resolve({ stdout, code });
      });
    });

    expect(output.stdout).to.include("Deployed real Covenant at 0x");

    // The three deliberate violations, each with its real decoded reason.
    expect(output.stdout).to.match(/scam impersonator token[\s\S]*?reason:\s+TokenNotAllowed/);
    expect(output.stdout).to.match(/notional above the 10 USDT cap[\s\S]*?reason:\s+NotionalExceeded/);
    expect(output.stdout).to.match(/while the oracle reports a halt[\s\S]*?reason:\s+OracleHalted/);

    // The contrast trade actually goes through - not every attempt in the
    // script is a denial, so this proves the guard isn't just rejecting
    // everything indiscriminately.
    expect(output.stdout).to.match(/oracle healthy[\s\S]*?allowed:\s+true[\s\S]*?reason:\s+None/);

    // Every tx hash printed is a real 32-byte hash, not a placeholder.
    const txHashes = [...output.stdout.matchAll(/tx:\s+(0x[0-9a-f]{64})/g)].map((m) => m[1]);
    expect(txHashes.length).to.equal(4);
  });
});

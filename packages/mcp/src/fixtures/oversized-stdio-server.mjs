const frameBytes = Number.parseInt(process.argv[2] ?? "0", 10);
const writeDelayMs = Number.parseInt(process.argv[3] ?? "0", 10);

if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0) {
  process.exit(2);
}

let triggered = false;
const keepAlive = setInterval(() => undefined, 1_000);

process.stdin.once("data", () => {
  triggered = true;
  setTimeout(() => {
    process.stdout.write(Buffer.alloc(frameBytes, 0x78));
  }, writeDelayMs);
});

process.stdin.on("end", () => {
  clearInterval(keepAlive);
  process.exit(triggered ? 0 : 3);
});

process.stdin.resume();

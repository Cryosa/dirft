// Runtime 重启模块
if (process.send) {
  let closing = false;
  const stop = (): void => {
    if (closing) return;
    closing = true;
    if (process.listenerCount("SIGTERM")) process.emit("SIGTERM");
    else process.exit(0);
  };
  process.on("message", (message: unknown) => {
    if ((message as { type?: string } | null)?.type === "dirft:stop") stop();
  });
  process.once("disconnect", () => {
    setTimeout(() => process.exit(0), 1000).unref();
    stop();
  });
  process.channel?.unref();
}

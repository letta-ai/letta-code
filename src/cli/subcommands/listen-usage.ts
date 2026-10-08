export function printListenUsage(): void {
  console.log(
    "Usage: letta server [--computer-name <name>] [--channels <list>] [--skills <path>] [--debug]\n",
  );
  console.log("Register this computer to receive messages from Letta Cloud.\n");
  console.log("Options:");
  console.log(
    "  --computer-name <name>  Friendly name for this computer (uses hostname if not provided)",
  );
  console.log(
    "  --channels <list>  Comma-separated channel names to enable (e.g. telegram)",
  );
  console.log(
    "  --skills <path>     Use this directory for computer-provided skills",
  );
  console.log(
    "  --install-channel-runtimes  Install missing runtime deps for the selected channels before startup",
  );
  console.log(
    "  --debug            Plain-text mode: log all WebSocket events instead of interactive UI",
  );
  console.log(
    "  --lifecycle-output jsonl  Emit payload-free JSON lifecycle transitions for a process supervisor",
  );
  console.log("  -h, --help         Show this help message\n");
  console.log("Examples:");
  console.log(
    "  letta channels configure telegram          # Configure Telegram first",
  );
  console.log(
    "  letta server                              # Uses hostname as default",
  );
  console.log('  letta server --computer-name "work-laptop"');
  console.log(
    "  letta server --channels telegram           # Enable Telegram channel",
  );
  console.log("  letta server --channels telegram --install-channel-runtimes");
  console.log(
    "  letta server --debug                       # Log all WS events\n",
  );
  console.log(
    "Once connected, this instance will listen for incoming messages from cloud agents.",
  );
  console.log("Messages will be executed locally on this computer.");
  console.log(
    "Telegram flow: configure the bot, start the listener with --channels telegram,",
  );
  console.log(
    "then message the bot from Telegram and run /channels telegram pair <code> in the target conversation.",
  );
}

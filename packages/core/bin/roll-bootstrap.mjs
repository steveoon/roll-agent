const SQLITE_COMMANDS = new Set(["chat", "schedule", "doctor", "update"]);

export function resolveCommandName(argv) {
  return argv.find((arg) => !arg.startsWith("-"));
}

export function shouldEnableSqliteForCommand(commandName) {
  return commandName !== undefined && SQLITE_COMMANDS.has(commandName);
}

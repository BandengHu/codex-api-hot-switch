export interface CodexCliLaunchSpec {
  command: string;
  args: string[] | null;
  options: Record<string, unknown>;
  displayCommand: string;
}

export function createCodexCliLaunchSpec({
  command,
  args,
  platform = process.platform,
}: {
  command: string;
  args: string[];
  platform?: NodeJS.Platform;
}): CodexCliLaunchSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/iu.test(command)) {
    return {
      command: buildWindowsShellCommandLine([command, ...args]),
      args: null,
      options: {
        shell: true,
        windowsHide: true,
      },
      displayCommand: command,
    };
  }
  return {
    command,
    args,
    options: {},
    displayCommand: command,
  };
}

function buildWindowsShellCommandLine(parts: string[]): string {
  return parts.map(quoteWindowsShellArgument).join(' ');
}

function quoteWindowsShellArgument(value: string): string {
  const normalized = String(value ?? '');
  if (!normalized) {
    return '""';
  }
  if (!/[\s"]/u.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

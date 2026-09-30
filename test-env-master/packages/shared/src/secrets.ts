const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /("?(?:password|token|api[_-]?key|authorization|secret)"?\s*[:=]\s*")([^"]*)(")/gi,
];

export function maskSecrets(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, ...groups) => {
      if (groups.length >= 3 && typeof groups[0] === "string") {
        return `${groups[0]}***${groups[2]}`;
      }
      if (/^Bearer\s+/i.test(match)) {
        return "Bearer ***";
      }
      return "***";
    });
  }
  return output;
}

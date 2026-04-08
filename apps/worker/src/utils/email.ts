export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailsMatch(left: string, right: string): boolean {
  return normalizeEmail(left) === normalizeEmail(right);
}

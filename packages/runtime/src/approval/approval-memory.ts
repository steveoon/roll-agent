export class SessionApprovalMemory {
  private readonly granted = new Set<string>();

  isGranted(key: string): boolean {
    return this.granted.has(key);
  }

  grant(key: string): void {
    this.granted.add(key);
  }
}

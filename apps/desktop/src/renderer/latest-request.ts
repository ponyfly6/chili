export interface LatestRequestGate {
  begin(): () => boolean;
  invalidate(): void;
}

export function createLatestRequestGate(): LatestRequestGate {
  let sequence = 0;
  return {
    begin() {
      const request = ++sequence;
      return () => request === sequence;
    },
    invalidate() {
      sequence += 1;
    },
  };
}

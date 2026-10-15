export interface PaymentOperationToken {
  readonly batchId: string;
  readonly generation: number;
  readonly controller: AbortController;
}

export function isPaymentOperationPreconditionSatisfied(
  viewBatchId: string | null | undefined,
  batchId: string,
  token: PaymentOperationToken,
): boolean {
  return viewBatchId === batchId && token.batchId === batchId;
}

export class PaymentOperationGuard {
  readonly batchId: string;
  private generation = 0;
  private mounted = true;
  private readonly controllers = new Set<AbortController>();

  constructor(batchId: string) {
    this.batchId = batchId;
  }

  mount(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.generation += 1;
  }

  dispose(): void {
    if (!this.mounted) return;
    this.abortAll();
    this.mounted = false;
    this.generation += 1;
  }

  capture(expectedBatchId: string): PaymentOperationToken | null {
    if (!this.mounted || expectedBatchId !== this.batchId) return null;
    const controller = new AbortController();
    this.controllers.add(controller);
    return { batchId: this.batchId, generation: this.generation, controller };
  }

  isCurrent(token: PaymentOperationToken): boolean {
    return this.mounted
      && !token.controller.signal.aborted
      && token.batchId === this.batchId
      && token.generation === this.generation;
  }

  release(token: PaymentOperationToken): void {
    this.controllers.delete(token.controller);
  }

  private abortAll(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

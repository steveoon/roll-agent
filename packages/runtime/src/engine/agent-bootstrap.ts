export const AGENT_BOOTSTRAP_MAX_CONCURRENCY = 4;

export interface BoundedConcurrencyOptions<Input, Output> {
  readonly signal: AbortSignal;
  readonly onSkipped: (input: Input, index: number) => Output;
}

export async function mapWithBoundedConcurrency<Input, Output>(
  inputs: readonly Input[],
  maxConcurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>,
  options?: BoundedConcurrencyOptions<Input, Output>,
): Promise<Output[]> {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("maxConcurrency must be a positive safe integer");
  }
  if (inputs.length === 0) {
    return [];
  }

  const entries = inputs.entries();
  const results: Array<{ value: Output } | undefined> = Array.from({
    length: inputs.length,
  });
  const workerCount = Math.min(maxConcurrency, inputs.length);

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (options?.signal.aborted === true) {
        return;
      }
      const entry = entries.next();
      if (entry.done) {
        return;
      }

      const [index, input] = entry.value;
      results[index] = { value: await mapper(input, index) };
    }
  };

  const workerResults = await Promise.allSettled(Array.from({ length: workerCount }, runWorker));
  const rejectedWorker = workerResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejectedWorker !== undefined) {
    throw rejectedWorker.reason;
  }
  if (options?.signal.aborted === true) {
    for (const [index, input] of inputs.entries()) {
      if (results[index] === undefined) {
        results[index] = { value: options.onSkipped(input, index) };
      }
    }
  }

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Missing bounded-concurrency result at index ${index}`);
    }
    return result.value;
  });
}

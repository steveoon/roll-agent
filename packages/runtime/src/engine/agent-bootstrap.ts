export const AGENT_BOOTSTRAP_MAX_CONCURRENCY = 2;

export async function mapWithBoundedConcurrency<Input, Output>(
  inputs: readonly Input[],
  maxConcurrency: number,
  mapper: (input: Input, index: number) => Promise<Output>,
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
      const entry = entries.next();
      if (entry.done) {
        return;
      }

      const [index, input] = entry.value;
      results[index] = { value: await mapper(input, index) };
    }
  };

  await Promise.all(Array.from({ length: workerCount }, runWorker));

  return results.map((result, index) => {
    if (result === undefined) {
      throw new Error(`Missing bounded-concurrency result at index ${index}`);
    }
    return result.value;
  });
}

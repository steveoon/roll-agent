import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type {
  ApprovalId,
  InteractionId,
  JsonRpcId,
  RuntimeInstanceId,
  RuntimeProtocolVersion,
  RuntimeServerRequestMethod,
} from "@roll-agent/protocol";

const logicalInteractionKeySchema = z.string().brand<"LogicalInteractionKey">();
const runtimeDeliveryIdSchema = z
  .string()
  .regex(/^runtime:[0-9a-f-]+$/u)
  .brand<"RuntimeDeliveryId">();

export type LogicalInteractionKey = z.output<typeof logicalInteractionKeySchema>;
export type RuntimeDeliveryId = z.output<typeof runtimeDeliveryIdSchema>;

export interface RuntimeClientInteractionInput<TResponderId extends string> {
  readonly key: string;
  readonly method: RuntimeServerRequestMethod;
  readonly params: unknown;
  readonly scopeId: RuntimeInstanceId;
  readonly eligibleResponderId: TResponderId;
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly interactionId: InteractionId;
  readonly legacyApprovalId: ApprovalId | undefined;
  readonly expiresAt: string | undefined;
  readonly resolveResponse: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface RuntimeClientDelivery<TAttachment extends object> {
  readonly id: RuntimeDeliveryId;
  readonly interactionKey: LogicalInteractionKey;
  readonly attachment: TAttachment;
  readonly generation: number;
}

export type RuntimeClientInteractionSettlement =
  | { readonly kind: "response" }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "expired"; readonly expiresAt: string }
  | { readonly kind: "failed"; readonly error: Error };

export type RuntimeClientInteractionState<TAttachment extends object> =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "delivered";
      readonly delivery: RuntimeClientDelivery<TAttachment>;
    }
  | {
      readonly kind: "settled";
      readonly outcome: RuntimeClientInteractionSettlement;
    };

export interface RuntimeClientInteraction<TResponderId extends string, TAttachment extends object> {
  readonly key: LogicalInteractionKey;
  readonly method: RuntimeServerRequestMethod;
  readonly params: unknown;
  readonly scopeId: RuntimeInstanceId;
  readonly eligibleResponderId: TResponderId;
  readonly protocolVersion: RuntimeProtocolVersion;
  readonly interactionId: InteractionId;
  readonly legacyApprovalId: ApprovalId | undefined;
  readonly expiresAt: string | undefined;
  readonly resolveResponse: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  state: RuntimeClientInteractionState<TAttachment>;
  nextDeliveryGeneration: number;
  expiresTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface RuntimeClientInteractionSettlementResult<TAttachment extends object> {
  readonly settled: boolean;
  readonly retiredDelivery: RuntimeClientDelivery<TAttachment> | undefined;
}

/**
 * Package-internal logical Interaction state. It is intentionally not exported from runtime's
 * package root: Protocol-visible IDs and capability negotiation belong to Runtime Protocol 1.2.
 */
export class RuntimeClientInteractionLifecycle<
  TResponderId extends string,
  TAttachment extends object,
> {
  private readonly interactions = new Map<
    LogicalInteractionKey,
    RuntimeClientInteraction<TResponderId, TAttachment>
  >();
  private readonly deliveries = new Map<JsonRpcId, RuntimeClientDelivery<TAttachment>>();

  has(key: string): boolean {
    return this.interactions.has(logicalInteractionKeySchema.parse(key));
  }

  register(
    input: RuntimeClientInteractionInput<TResponderId>,
  ): RuntimeClientInteraction<TResponderId, TAttachment> {
    const key = logicalInteractionKeySchema.parse(input.key);
    if (this.interactions.has(key)) {
      throw new Error(`Logical Interaction "${input.key}" already exists`);
    }
    const interaction: RuntimeClientInteraction<TResponderId, TAttachment> = {
      key,
      method: input.method,
      params: input.params,
      scopeId: input.scopeId,
      eligibleResponderId: input.eligibleResponderId,
      protocolVersion: input.protocolVersion,
      interactionId: input.interactionId,
      legacyApprovalId: input.legacyApprovalId,
      expiresAt: input.expiresAt,
      resolveResponse: input.resolveResponse,
      reject: input.reject,
      state: { kind: "waiting" },
      nextDeliveryGeneration: 1,
      expiresTimer: undefined,
    };
    this.interactions.set(key, interaction);
    return interaction;
  }

  get(key: string): RuntimeClientInteraction<TResponderId, TAttachment> | undefined {
    return this.interactions.get(logicalInteractionKeySchema.parse(key));
  }

  getByDeliveryId(id: JsonRpcId):
    | {
        readonly interaction: RuntimeClientInteraction<TResponderId, TAttachment>;
        readonly delivery: RuntimeClientDelivery<TAttachment>;
      }
    | undefined {
    const delivery = this.deliveries.get(id);
    if (delivery === undefined) {
      return undefined;
    }
    const interaction = this.interactions.get(delivery.interactionKey);
    if (
      interaction === undefined ||
      interaction.state.kind !== "delivered" ||
      interaction.state.delivery !== delivery
    ) {
      this.deliveries.delete(id);
      return undefined;
    }
    return { interaction, delivery };
  }

  beginDelivery(
    interaction: RuntimeClientInteraction<TResponderId, TAttachment>,
    attachment: TAttachment,
  ): RuntimeClientDelivery<TAttachment> | undefined {
    if (interaction.state.kind !== "waiting") {
      return undefined;
    }
    return this.activateDelivery(interaction, attachment);
  }

  replaceDelivery(
    interaction: RuntimeClientInteraction<TResponderId, TAttachment>,
    attachment: TAttachment,
  ):
    | {
        readonly previous: RuntimeClientDelivery<TAttachment>;
        readonly delivery: RuntimeClientDelivery<TAttachment>;
      }
    | undefined {
    if (interaction.state.kind !== "delivered") {
      return undefined;
    }
    const previous = interaction.state.delivery;
    this.deliveries.delete(previous.id);
    interaction.state = { kind: "waiting" };
    const delivery = this.activateDelivery(interaction, attachment);
    return delivery === undefined ? undefined : { previous, delivery };
  }

  pendingForAttachment(
    attachment: TAttachment,
  ): readonly RuntimeClientInteraction<TResponderId, TAttachment>[] {
    return [...this.interactions.values()].filter(
      (interaction) =>
        interaction.state.kind === "delivered" &&
        interaction.state.delivery.attachment === attachment,
    );
  }

  pending(): readonly RuntimeClientInteraction<TResponderId, TAttachment>[] {
    return [...this.interactions.values()];
  }

  settle(
    interaction: RuntimeClientInteraction<TResponderId, TAttachment>,
    outcome: RuntimeClientInteractionSettlement,
  ): RuntimeClientInteractionSettlementResult<TAttachment> {
    if (
      interaction.state.kind === "settled" ||
      this.interactions.get(interaction.key) !== interaction
    ) {
      return { settled: false, retiredDelivery: undefined };
    }
    const retiredDelivery =
      interaction.state.kind === "delivered" ? interaction.state.delivery : undefined;
    if (retiredDelivery !== undefined) {
      this.deliveries.delete(retiredDelivery.id);
    }
    this.interactions.delete(interaction.key);
    if (interaction.expiresTimer !== undefined) {
      clearTimeout(interaction.expiresTimer);
      interaction.expiresTimer = undefined;
    }
    interaction.state = { kind: "settled", outcome };
    return { settled: true, retiredDelivery };
  }

  private activateDelivery(
    interaction: RuntimeClientInteraction<TResponderId, TAttachment>,
    attachment: TAttachment,
  ): RuntimeClientDelivery<TAttachment> | undefined {
    if (
      interaction.state.kind !== "waiting" ||
      this.interactions.get(interaction.key) !== interaction
    ) {
      return undefined;
    }
    const delivery: RuntimeClientDelivery<TAttachment> = {
      id: runtimeDeliveryIdSchema.parse(`runtime:${randomUUID()}`),
      interactionKey: interaction.key,
      attachment,
      generation: interaction.nextDeliveryGeneration,
    };
    interaction.nextDeliveryGeneration += 1;
    interaction.state = { kind: "delivered", delivery };
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }
}

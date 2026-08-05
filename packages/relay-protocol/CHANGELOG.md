# @roll-agent/relay-protocol

## 0.2.0

### Minor Changes

- [#199](https://github.com/steveoon/roll-agent/pull/199) [`cc19da9`](https://github.com/steveoon/roll-agent/commit/cc19da92533320cf4ebff9ba665001f1194f2776) Thanks [@steveoon](https://github.com/steveoon)! - Add the explicitly versioned Relay Wire 1.1 interaction contract, safe Browser reference adapter,
  JSON Schema, fixtures, and N/N-1 conformance while keeping every legacy Wire 1.0 API and fixture
  frozen.

- [#204](https://github.com/steveoon/roll-agent/pull/204) [`90afb81`](https://github.com/steveoon/roll-agent/commit/90afb819604dd718a59e5d0065b80f6a9b8ded23) Thanks [@steveoon](https://github.com/steveoon)! - Add explicit Relay Wire 1.1 query projectors for snapshots and operations, apply them in the
  Companion bridge, and prevent Runtime or local policy error details from crossing the Relay wire.

### Patch Changes

- [#196](https://github.com/steveoon/roll-agent/pull/196) [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733) Thanks [@steveoon](https://github.com/steveoon)! - Negotiate Runtime Protocol 1.2 Server Request capabilities before delivery, carry branded
  Interaction metadata on Approval requests, cancel 1.2 requests by InteractionId, and keep the
  Protocol 1.1 and 1.0 control paths wire-compatible.
  Freeze Relay Wire 1.0 against Runtime 1.2 schema drift and project newer Runtime snapshots and
  events to its existing Runtime 1.1-compatible envelope before remote delivery.
- Updated dependencies [[`c9597e3`](https://github.com/steveoon/roll-agent/commit/c9597e3520059701640f3cc33cf7bf1be0bf0e8d), [`df979d9`](https://github.com/steveoon/roll-agent/commit/df979d98dcf09250f6705a599b42c13bafba915a), [`e17ca19`](https://github.com/steveoon/roll-agent/commit/e17ca19259e5b8a263aa99bfa0979e475ab3c00d), [`fda44ec`](https://github.com/steveoon/roll-agent/commit/fda44ec80bd87fae0492d4f41fbd7677f680e733)]:
  - @roll-agent/protocol@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`bc81138`](https://github.com/steveoon/roll-agent/commit/bc8113876972545039714f15dc451068c2e4b6dd)]:
  - @roll-agent/protocol@0.3.0

## 0.1.0

### Minor Changes

- [#191](https://github.com/steveoon/roll-agent/pull/191) [`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494) Thanks [@steveoon](https://github.com/steveoon)! - Extract the versioned, Browser-safe Relay Protocol and conformance suite into a
  standalone package while keeping Companion compatibility exports. Make replay
  classification request-identity aware, expose exact method dispositions to
  cross-language consumers, and fail a Relay transport generation on ordered-send
  errors so events and cached mutation responses recover without duplicate Runtime
  execution or ACK gaps.

### Patch Changes

- Updated dependencies [[`7b6c586`](https://github.com/steveoon/roll-agent/commit/7b6c586e34d467b3089aed94f62528ebb2a6a494)]:
  - @roll-agent/protocol@0.2.0

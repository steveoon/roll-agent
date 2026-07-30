# @roll-agent/relay-protocol

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

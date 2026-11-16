# Implementation Plan

- [ ] 1. Modernize `SafeMath`
  - [ ] 1.1 Port to Solidity 0.8.x and keep the external interface
- [ ] 2. Modernize `ERC20`
  - [ ] 2.1 Port to Solidity 0.8.x and keep the external interface
- [ ] 3. Modernize `LegacyVault`
  - [ ] 3.1 Port to Solidity 0.8.x and keep the external interface
  - [ ] 3.2 Fix tx-origin-auth in onlyOwner
  - [ ] 3.3 Fix call-before-write in deposit
  - [ ] 3.4 Fix call-before-write in withdraw
  - [ ] 3.5 Fix call-before-write in swapEthForTokens
  - [ ] 3.6 Fix unchecked-call in sweepProtocolFees
  - [ ] 3.7 Fix call-before-write in sweepProtocolFees
  - [ ] 3.8 Add Pausable and register `balance-conservation` with Aegis Sentinel

# Design Document: Modernize legacy-vault.sol

## Overview

Upgrade `SafeMath`, `ERC20`, `LegacyVault` to Solidity 0.8.x, keep the external interface, and fix each detected risk.

## Proposed invariants

- `LegacyVault`: `balance-conservation` (Σ balanceOf = totalSupply)

## Risk fixes

- legacy-pragma at SafeMath (1:0)
- legacy-pragma at ERC20 (1:0)
- legacy-pragma at LegacyVault (1:0)
- tx-origin-auth at LegacyVault.onlyOwner (75:16)
- call-before-write at LegacyVault.deposit (103:8)
- call-before-write at LegacyVault.withdraw (121:8)
- call-before-write at LegacyVault.swapEthForTokens (140:8)
- unchecked-call at LegacyVault.sweepProtocolFees (157:8)
- call-before-write at LegacyVault.sweepProtocolFees (158:8)

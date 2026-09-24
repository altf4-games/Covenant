// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title Gate
/// @notice Throwaway contract for Phase 3 Day 1's hard gate
/// (PLAN-PHASE3-V2-2026-09-24.md). Its only job is to prove a real
/// `baw contract-call preview` -> `execute` round trip actually works
/// against a self-deployed, BscScan-verified contract on BSC mainnet,
/// before anything real (Covenant v2, the reconciled mandate) gets built on
/// that assumption. `CLAUDE-UPDATES-2026-09-24.md` §2 explains why this
/// couldn't be assumed from developer mode being enabled alone - G2 was
/// never actually tested. Not the final contract; deliberately minimal.
contract Gate {
    event Pinged(address indexed caller, uint256 value, uint256 timestamp);

    uint256 public pingCount;
    address public lastCaller;

    /// @notice A trivial state-changing call, real enough for
    /// `contract-call preview` to simulate and `execute` to broadcast.
    function ping(uint256 value) external {
        pingCount += 1;
        lastCaller = msg.sender;
        emit Pinged(msg.sender, value, block.timestamp);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface ICovenantForAttack {
    function guardedSwap(address tokenOut, uint24 fee, uint256 amountIn, uint256 amountOutMinimum)
        external
        returns (uint256);
}

/// @notice Not a real token. Exists only so the unit test suite can prove
/// Covenant's reentrancy guard actually blocks a reentrant call, instead of
/// trusting that the modifier is wired up correctly by inspection alone.
/// `transferFrom` calls straight back into `guardedSwap` on the configured
/// target, mid-call, the way a malicious quoteToken would.
contract MaliciousReentrantToken {
    address public attackTarget;
    address public attackTokenOut;

    function setAttack(address target, address tokenOut) external {
        attackTarget = target;
        attackTokenOut = tokenOut;
    }

    function transferFrom(address, address, uint256 amount) external returns (bool) {
        // Reenter guardedSwap while Covenant's nonReentrant lock is held.
        ICovenantForAttack(attackTarget).guardedSwap(attackTokenOut, 2500, amount, 0);
        return true;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }
}

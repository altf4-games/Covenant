// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

interface IMintableERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
}

/// @notice Stand-in for PancakeSwap's V3 SwapRouter with the same
/// struct-based exactInputSingle signature, used only for Covenant's own
/// unit tests (see MockERC20.sol for why). Fixed 1:1 exchange rate -
/// deterministic and easy to assert on. Real swap behavior, real slippage,
/// real liquidity is what test/Covenant.fork.ts checks against the actual
/// router.
contract MockRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        IMintableERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn;
        require(amountOut >= params.amountOutMinimum, "MockRouter: amountOutMinimum");
        IMintableERC20(params.tokenOut).mint(params.recipient, amountOut);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Only `balanceOf`, declared `view` so the compiler issues a
/// STATICCALL: an allowlisted token can't change Covenant's state from
/// inside it, so no reentrancy guard is needed.
interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Covenant
/// @notice An on-chain decision ledger for an AI agent trading tokenized
/// stocks. The agent's Binance Agentic Wallet keeps custody and executes
/// every trade natively (`baw market-order swap`). Before each trade the
/// agent commits the trade here and Covenant decides, on chain, whether the
/// owner's mandate allows it. After the trade the agent settles the real
/// fill. `scripts/verify.ts` then reconciles every real token transfer in
/// and out of the wallet against settled decisions, so any trade made
/// without an approved decision shows up publicly.
///
/// @dev What this does and doesn't claim. Covenant can't physically stop the
/// wallet from trading; Binance's own wallet guardrails bound that. What it
/// guarantees is that no trade happens unseen: each one either maps to a
/// decision committed on chain before it happened, or it's flagged. See
/// docs/research/opus-review-2026-09-24.md §5 for why this design replaced
/// v1's `guardedSwap` and the oracle bond (both remain in git history).
///
/// Units: every USD figure (notional caps, position caps, oracle prices) is
/// in the quote token's smallest unit. BSC USDT and every bStock have 18
/// decimals (docs/research/verified-facts.md), so `priceUsd` is quote units
/// per 1e18 token units, i.e. the plain price scaled by 1e18.
///
/// "Per day" is the UTC calendar day (`block.timestamp / 1 days`).
contract Covenant {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum Side {
        Buy, // spend `amountIn` quote tokens, receive the stock token
        Sell // spend `amountIn` stock tokens, receive quote tokens
    }

    /// @notice Why a proposed trade was denied. `None` means allowed.
    /// Values are append-only: off-chain decoders index into this list.
    enum DenialReason {
        None,
        MandateInactive,
        MandateExpired,
        TokenNotAllowed,
        NotionalExceeded,
        DailyLimitExceeded,
        OracleStale,
        OracleHalted,
        SlippageTooLoose,
        PositionLimit,
        DecisionOpen,
        ClosedMarketDrift
    }

    /// @notice How the real fill was executed, as reported by the agent at
    /// settle time. bStocks can fill through RFQ or a pool, and the wallet
    /// picks, not the agent (official workshop, 2026-09-24).
    enum ExecutionMode {
        Unknown,
        Pool,
        Rfq,
        Aggregator
    }

    struct Mandate {
        bool active;
        uint256 maxNotionalPerTradeUsd;
        uint256 maxTradesPerDay;
        uint256 expiry;
    }

    struct DailyUsage {
        uint256 day;
        uint256 count;
    }

    struct TokenConfig {
        bool allowed;
        uint16 maxSlippageBps;
        uint256 maxPositionUsd;
        // Feature 1. 0 turns the closed-market drift rule off for this token.
        uint16 maxClosedMarketDriftBps;
    }

    struct OracleStatus {
        bool halted;
        uint256 priceUsd;
        uint256 updatedAt;
        // Feature 1: is the underlying exchange (NYSE) in its regular
        // session, and the token's own price at that session's last close.
        bool sessionOpen;
        uint256 lastCloseUsd;
    }

    struct Decision {
        Side side;
        address token;
        uint256 amountIn;
        uint256 quotedOut;
        uint256 minOut;
        bool allowed;
        DenialReason reason;
        uint64 committedAt;
        uint64 expiresAt;
        bool settled;
        bool cancelled;
        bytes32 quoteRef;
        bytes32 researchRef;
        bytes32 swapTxHash;
        uint256 amountOut;
        ExecutionMode executionMode;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public owner;
    address public oracleUpdater;
    address public agent;

    /// @notice The token trades are priced in (USDT on BSC).
    address public immutable quoteToken;
    /// @notice Oracle data older than this is treated as stale.
    uint256 public immutable stalenessBound;
    /// @notice How long an approved decision stays valid for execution.
    uint256 public immutable decisionTtl;

    Mandate public mandate;
    DailyUsage public usage;

    mapping(address => TokenConfig) public tokenConfig;
    mapping(address => OracleStatus) public oracleStatus;
    mapping(uint256 => Decision) internal _decisions;

    uint256 public nextDecisionId = 1;
    /// @notice The single approved decision still in flight, or 0.
    uint256 public openDecisionId;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event MandateSet(uint256 maxNotionalPerTradeUsd, uint256 maxTradesPerDay, uint256 expiry);
    event MandateRevoked();
    event TokenConfigured(address indexed token, bool allowed, uint16 maxSlippageBps, uint256 maxPositionUsd);
    event ClosedMarketDriftSet(address indexed token, uint16 maxClosedMarketDriftBps);
    event OracleUpdaterChanged(address indexed updater);
    event AgentChanged(address indexed agent);
    event OracleUpdated(
        address indexed token, bool halted, uint256 priceUsd, bool sessionOpen, uint256 lastCloseUsd, uint256 updatedAt
    );

    /// @notice Emitted for every commit, allowed or denied. This is the
    /// public record a trade is reconciled against.
    event DecisionCommitted(
        uint256 indexed id,
        address indexed token,
        Side side,
        bool allowed,
        DenialReason reason,
        uint256 amountIn,
        uint256 quotedOut,
        uint256 minOut,
        bytes32 quoteRef,
        bytes32 researchRef,
        uint64 expiresAt
    );

    event DecisionSettled(
        uint256 indexed id, bytes32 indexed swapTxHash, uint256 amountOut, ExecutionMode executionMode, bool belowMin
    );

    event DecisionCancelled(uint256 indexed id);

    // ---------------------------------------------------------------------
    // Errors (access and input validation only - policy denials are
    // recorded as DecisionCommitted events, never reverts)
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotOracleUpdater();
    error NotAgent();
    error ZeroAddress();
    error RolesNotDistinct();
    error ExpiryInPast();
    error InvalidBound();
    error ZeroPrice();
    error DecisionDoesNotExist();
    error DecisionNotAllowed();
    error DecisionClosed();
    error ZeroTxHash();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOracleUpdater() {
        if (msg.sender != oracleUpdater) revert NotOracleUpdater();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @dev Owner, oracle updater and agent must be three different keys.
    /// If the agent could post its own oracle, or the owner doubled as the
    /// updater, the checks below would mean nothing (red-team finding H6).
    constructor(
        address _quoteToken,
        address _oracleUpdater,
        address _agent,
        uint256 _stalenessBound,
        uint256 _decisionTtl
    ) {
        if (_quoteToken == address(0) || _oracleUpdater == address(0) || _agent == address(0)) {
            revert ZeroAddress();
        }
        if (_oracleUpdater == msg.sender || _agent == msg.sender || _oracleUpdater == _agent) {
            revert RolesNotDistinct();
        }
        if (_stalenessBound < 60 || _stalenessBound > 1 days) revert InvalidBound();
        if (_decisionTtl < 60 || _decisionTtl > 1 hours) revert InvalidBound();

        owner = msg.sender;
        quoteToken = _quoteToken;
        oracleUpdater = _oracleUpdater;
        agent = _agent;
        stalenessBound = _stalenessBound;
        decisionTtl = _decisionTtl;
        emit OracleUpdaterChanged(_oracleUpdater);
        emit AgentChanged(_agent);
    }

    // ---------------------------------------------------------------------
    // Owner administration
    // ---------------------------------------------------------------------

    function setMandate(uint256 maxNotionalPerTradeUsd, uint256 maxTradesPerDay, uint256 expiry) external onlyOwner {
        if (expiry <= block.timestamp) revert ExpiryInPast();
        mandate = Mandate({
            active: true,
            maxNotionalPerTradeUsd: maxNotionalPerTradeUsd,
            maxTradesPerDay: maxTradesPerDay,
            expiry: expiry
        });
        emit MandateSet(maxNotionalPerTradeUsd, maxTradesPerDay, expiry);
    }

    function revokeMandate() external onlyOwner {
        mandate.active = false;
        emit MandateRevoked();
    }

    /// @notice Allow a token by exact address and set its slippage bound
    /// and position cap. There is no ticker resolution on chain on purpose:
    /// that step is where provider confusion (NVDAB vs NVDAon) and
    /// impersonator tokens get in. Resolve off chain, pin the address here.
    function configureToken(address token, bool allowed, uint16 maxSlippageBps, uint256 maxPositionUsd)
        external
        onlyOwner
    {
        if (token == address(0)) revert ZeroAddress();
        if (maxSlippageBps > 10_000) revert InvalidBound();
        TokenConfig storage cfg = tokenConfig[token];
        cfg.allowed = allowed;
        cfg.maxSlippageBps = maxSlippageBps;
        cfg.maxPositionUsd = maxPositionUsd;
        emit TokenConfigured(token, allowed, maxSlippageBps, maxPositionUsd);
    }

    /// @notice Feature 1: while the underlying exchange is closed, deny a
    /// buy priced more than `bps` above the token's last-close price, or a
    /// sell priced that far below it. In plain words: don't let the agent
    /// pay a weekend premium on a stock whose real market is shut. 0 turns
    /// the rule off for this token.
    function setClosedMarketDrift(address token, uint16 bps) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (bps > 10_000) revert InvalidBound();
        tokenConfig[token].maxClosedMarketDriftBps = bps;
        emit ClosedMarketDriftSet(token, bps);
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        if (newAgent == owner || newAgent == oracleUpdater) revert RolesNotDistinct();
        agent = newAgent;
        openDecisionId = 0;
        emit AgentChanged(newAgent);
    }

    function setOracleUpdater(address updater) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        if (updater == owner || updater == agent) revert RolesNotDistinct();
        oracleUpdater = updater;
        emit OracleUpdaterChanged(updater);
    }

    // ---------------------------------------------------------------------
    // Oracle
    // ---------------------------------------------------------------------

    /// @notice Push a token's live market status and price, plus the
    /// underlying exchange's session state and the token's price at its
    /// last close. Fed by scripts/oracle-updater.ts from the RWA status and
    /// dynamic endpoints, a NYSE calendar, and the market K-line endpoint.
    /// All five fields go stale together.
    function updateOracle(address token, bool halted, uint256 priceUsd, bool sessionOpen, uint256 lastCloseUsd)
        external
        onlyOracleUpdater
    {
        if (priceUsd == 0 || lastCloseUsd == 0) revert ZeroPrice();
        oracleStatus[token] = OracleStatus({
            halted: halted,
            priceUsd: priceUsd,
            updatedAt: block.timestamp,
            sessionOpen: sessionOpen,
            lastCloseUsd: lastCloseUsd
        });
        emit OracleUpdated(token, halted, priceUsd, sessionOpen, lastCloseUsd, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // The decision loop: commit -> (native swap) -> settle
    // ---------------------------------------------------------------------

    /// @notice Decide a trade before it happens. Never reverts on a policy
    /// denial: a denied commit still mines and emits `DecisionCommitted`
    /// with `allowed: false`, so refusals are on chain too.
    /// @param quotedOut What `baw market-order quote` said the trade returns.
    /// @param minOut The least the agent will accept. Must sit within the
    /// token's slippage bound of both the quote and the oracle price.
    /// @param quoteRef Hash of the raw quote response, for the audit trail.
    /// @param researchRef Hash of any paid research behind the trade, or 0.
    function commit(
        Side side,
        address token,
        uint256 amountIn,
        uint256 quotedOut,
        uint256 minOut,
        bytes32 quoteRef,
        bytes32 researchRef
    ) external onlyAgent returns (uint256 id) {
        DenialReason reason = _evaluate(side, token, amountIn, quotedOut, minOut);
        bool allowed = reason == DenialReason.None;

        id = nextDecisionId++;
        uint64 expiresAt = allowed ? uint64(block.timestamp + decisionTtl) : uint64(block.timestamp);

        Decision storage d = _decisions[id];
        d.side = side;
        d.token = token;
        d.amountIn = amountIn;
        d.quotedOut = quotedOut;
        d.minOut = minOut;
        d.allowed = allowed;
        d.reason = reason;
        d.committedAt = uint64(block.timestamp);
        d.expiresAt = expiresAt;
        d.quoteRef = quoteRef;
        d.researchRef = researchRef;

        if (allowed) {
            _recordTrade();
            openDecisionId = id;
        }

        emit DecisionCommitted(
            id, token, side, allowed, reason, amountIn, quotedOut, minOut, quoteRef, researchRef, expiresAt
        );
    }

    /// @notice Record the real fill of an approved decision. The numbers are
    /// the agent's claim; verify.ts checks them against the swap's real
    /// transfers. Settling after `expiresAt` is allowed (the swap may have
    /// landed in time), and verify.ts checks the swap's block timestamp.
    function settle(uint256 id, bytes32 swapTxHash, uint256 amountOut, ExecutionMode executionMode)
        external
        onlyAgent
    {
        Decision storage d = _existing(id);
        if (!d.allowed) revert DecisionNotAllowed();
        if (d.settled || d.cancelled) revert DecisionClosed();
        if (swapTxHash == bytes32(0)) revert ZeroTxHash();

        d.settled = true;
        d.swapTxHash = swapTxHash;
        d.amountOut = amountOut;
        d.executionMode = executionMode;
        if (openDecisionId == id) openDecisionId = 0;

        emit DecisionSettled(id, swapTxHash, amountOut, executionMode, amountOut < d.minOut);
    }

    /// @notice Abandon an approved decision without trading. It still
    /// counts toward the day, so commit/cancel can't be used to churn.
    function cancel(uint256 id) external onlyAgent {
        Decision storage d = _existing(id);
        if (!d.allowed) revert DecisionNotAllowed();
        if (d.settled || d.cancelled) revert DecisionClosed();

        d.cancelled = true;
        if (openDecisionId == id) openDecisionId = 0;
        emit DecisionCancelled(id);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The exact decision `commit` would make right now, with no
    /// state change. Same `_evaluate` as `commit`, so the two can't drift.
    function previewDecision(Side side, address token, uint256 amountIn, uint256 quotedOut, uint256 minOut)
        external
        view
        returns (DenialReason)
    {
        return _evaluate(side, token, amountIn, quotedOut, minOut);
    }

    function getDecision(uint256 id) external view returns (Decision memory) {
        return _decisions[id];
    }

    function tradesUsedToday() public view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        return usage.day == today ? usage.count : 0;
    }

    /// @notice True while an approved decision is neither settled,
    /// cancelled, nor past its expiry.
    function hasOpenDecision() public view returns (bool) {
        uint256 id = openDecisionId;
        if (id == 0) return false;
        Decision storage d = _decisions[id];
        return !d.settled && !d.cancelled && block.timestamp <= d.expiresAt;
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _evaluate(Side side, address token, uint256 amountIn, uint256 quotedOut, uint256 minOut)
        internal
        view
        returns (DenialReason)
    {
        Mandate memory m = mandate;
        if (!m.active) return DenialReason.MandateInactive;
        if (block.timestamp > m.expiry) return DenialReason.MandateExpired;

        TokenConfig memory cfg = tokenConfig[token];
        if (!cfg.allowed) return DenialReason.TokenNotAllowed;

        // One trade in flight at a time. Without this, several buys could
        // each pass the position check against the same pre-trade balance.
        if (hasOpenDecision()) return DenialReason.DecisionOpen;

        OracleStatus memory o = oracleStatus[token];
        if (o.updatedAt == 0 || block.timestamp - o.updatedAt > stalenessBound) return DenialReason.OracleStale;
        if (o.halted) return DenialReason.OracleHalted;

        uint256 notional = side == Side.Buy ? amountIn : (amountIn * o.priceUsd) / 1e18;
        if (notional > m.maxNotionalPerTradeUsd) return DenialReason.NotionalExceeded;
        if (tradesUsedToday() >= m.maxTradesPerDay) return DenialReason.DailyLimitExceeded;

        // The minimum must be close to the agent's own quote AND to the
        // oracle price. The oracle leg means an understated quote can't be
        // used to smuggle in a loose minimum (red-team finding H5).
        uint256 oracleOut = side == Side.Buy ? (amountIn * 1e18) / o.priceUsd : (amountIn * o.priceUsd) / 1e18;
        uint256 floorBps = 10_000 - cfg.maxSlippageBps;
        if (quotedOut == 0 || minOut * 10_000 < quotedOut * floorBps || minOut * 10_000 < oracleOut * floorBps) {
            return DenialReason.SlippageTooLoose;
        }

        // Feature 1: the closed-market drift rule. The implied price is
        // from the agent's own quote; the slippage check above already ties
        // the quote to both the minimum and the oracle, so an inflated quote
        // can't hide a bad fill. Both sides of the comparison are the token's
        // own price, so no token-to-share normalisation is needed here.
        if (!o.sessionOpen && cfg.maxClosedMarketDriftBps > 0) {
            if (side == Side.Buy) {
                uint256 implied = (amountIn * 1e18) / quotedOut;
                if (implied * 10_000 > o.lastCloseUsd * (10_000 + uint256(cfg.maxClosedMarketDriftBps))) {
                    return DenialReason.ClosedMarketDrift;
                }
            } else {
                uint256 implied = (quotedOut * 1e18) / amountIn;
                if (implied * 10_000 < o.lastCloseUsd * (10_000 - uint256(cfg.maxClosedMarketDriftBps))) {
                    return DenialReason.ClosedMarketDrift;
                }
            }
        }

        // Feature 3: the position cap, read from the wallet's real on-chain
        // balance, not from anything the agent reports.
        if (side == Side.Buy) {
            uint256 held = IERC20Balance(token).balanceOf(agent);
            uint256 received = quotedOut > oracleOut ? quotedOut : oracleOut;
            if (((held + received) * o.priceUsd) / 1e18 > cfg.maxPositionUsd) return DenialReason.PositionLimit;
        }

        return DenialReason.None;
    }

    function _existing(uint256 id) internal view returns (Decision storage) {
        if (id == 0 || id >= nextDecisionId) revert DecisionDoesNotExist();
        return _decisions[id];
    }

    function _recordTrade() internal {
        uint256 today = block.timestamp / 1 days;
        if (usage.day == today) {
            usage.count += 1;
        } else {
            usage.day = today;
            usage.count = 1;
        }
    }
}

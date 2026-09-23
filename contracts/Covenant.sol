// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @dev Just the ERC20 surface Covenant needs. No point pulling in a full
/// OpenZeppelin dependency for four function signatures.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @dev PancakeSwap V3 SwapRouter, exactInputSingle only. Verified live on BSC
/// mainnet at 0x1b81D678ffb9C0263b24A97847620C99d213eB14 (factory() returns
/// the real PancakeV3Factory address) - see docs/research/verified-facts.md.
///
/// Field order matches PancakeSwap's own ISwapRouter.sol exactly (confirmed
/// against github.com/pancakeswap/pancake-v3-contracts) - `deadline` sits
/// between `recipient` and `amountIn`. An earlier version of this file was
/// missing that field entirely, which doesn't fail to compile (the struct is
/// still well-formed Solidity) but silently misaligns every field from
/// `amountIn` onward when ABI-encoded against the real router, producing a
/// revert with no reason string. Caught by test/Covenant.fork.ts, which is
/// exactly the kind of bug an interface written against docs/memory instead
/// of the deployed contract's actual source produces - see the README's
/// "Tests, and what they caught" section.
interface IPancakeV3SwapRouter {
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

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title Covenant
/// @notice An on-chain execution mandate for tokenized-stock trades. A human
/// sets a mandate (which tokens, how much per trade, how many trades a day,
/// until when); an agent proposes swaps against it; Covenant decides, on
/// chain, whether the trade happens - and writes an attestation event either
/// way, so the decision is independently verifiable by anyone with an RPC
/// endpoint, not just trusted because the agent says so.
///
/// @dev Design choices worth flagging for a reviewer:
///
/// 1. Guard failures do not revert. A reverted transaction discards every
///    state change, including events - so a denial that reverted would leave
///    no on-chain trace for a judge (or anyone else) to point to. Instead,
///    `guardedSwap` evaluates the mandate and oracle first, and if the trade
///    is denied it emits `Attestation(..., allowed: false, reason: ...)` and
///    returns 0 without reverting. The transaction still mines, costs gas
///    only, and moves no principal. A genuine DEX-level failure (e.g. price
///    moved past `amountOutMinimum`) still reverts normally, because that is
///    PancakeSwap's decision, not Covenant's.
///
/// 2. Non-custodial. Covenant never holds trading funds between calls. The
///    caller approves `quoteToken` beforehand; a call that passes the guard
///    pulls exactly `amountIn` via `transferFrom`, swaps it, and has the
///    router deliver the output directly to the caller. A denied call never
///    touches the caller's balance at all.
///
/// 3. "Per day" means the UTC calendar day (`block.timestamp / 1 days`), not
///    a strict sliding 24h window. That is a real simplification, not an
///    oversight - it is what "max trades per day" means to a human setting a
///    mandate, and it is cheap to reason about and test. Documented here so
///    nobody mistakes it for a bug later.
///
/// 4. The guard above verifies oracle data is *fresh*, not *accurate* - a
///    malicious or buggy oracle updater could post a status that passes
///    every check and is simply wrong. The bond/challenge/slash mechanism
///    further down (`postBond`, `challengeUpdate`, `resolveChallenge`) makes
///    that specific trust assumption economically enforced instead of
///    merely trusted. See that section's own comment for the two disclosed
///    simplifications (role-tied bond, manual resolution) and
///    docs/research/slashable-guard-spec.md for the full design rationale.
contract Covenant {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice Why a proposed trade was allowed or denied. `None` means allowed.
    enum DenialReason {
        None,
        MandateInactive,
        MandateExpired,
        TokenNotAllowed,
        NotionalExceeded,
        DailyLimitExceeded,
        OracleStale,
        OracleHalted
    }

    struct Mandate {
        bool active;
        uint256 maxNotionalPerTrade; // in quoteToken units (e.g. USDT wei)
        uint256 maxTradesPerDay;
        uint256 expiry; // unix timestamp; trade denied once block.timestamp exceeds this
    }

    struct DailyUsage {
        uint256 day; // block.timestamp / 1 days, for the last recorded trade
        uint256 count; // trades recorded on `day`
    }

    struct OracleStatus {
        bool halted;
        uint256 updatedAt; // unix timestamp of the last update; 0 = never updated
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public owner;
    address public oracleUpdater;

    /// @notice The token trades are denominated and paid in (USDT on BSC).
    address public immutable quoteToken;
    /// @notice PancakeSwap V3 SwapRouter this contract forwards allowed swaps to.
    address public immutable swapRouter;
    /// @notice Oracle data older than this many seconds is treated as stale, not trusted.
    uint256 public immutable stalenessBound;

    Mandate public mandate;
    DailyUsage public usage;

    /// @notice Provider-pinned allowlist: the exact token address a mandate
    /// permits, e.g. real NVDAB, never a bare "NVDA" ticker that could
    /// resolve to a different provider's token or a scam contract.
    mapping(address => bool) public allowedTokens;
    mapping(address => OracleStatus) public oracleStatus;

    uint256 private _locked = 1;

    // ---------------------------------------------------------------------
    // Slashable oracle-accuracy guard (Phase 2.5)
    // ---------------------------------------------------------------------
    //
    // The mandate/oracle/attestation guard above can verify oracle data is
    // *fresh* (the staleness bound) but not *accurate* - a malicious or
    // buggy updater could post a status that passes every check above and
    // is simply wrong. This section makes that specific trust assumption
    // economically enforced instead of merely trusted: the updater posts a
    // bond, anyone can challenge a specific update with off-chain evidence
    // it was wrong, and an upheld challenge slashes part of the bond to the
    // challenger. See docs/research/slashable-guard-spec.md for the full
    // design rationale.
    //
    // Disclosed simplifications, deliberate for a hackathon demo, not a
    // production security model:
    // - The bond is tied to the *role* (whichever address currently holds
    //   `oracleUpdater`), not to a specific historical address. If the role
    //   changes hands, the incoming updater inherits accountability for
    //   whatever bond is already posted; the outgoing updater should
    //   withdraw first if that's not the intent. A production version would
    //   key bonds per-address and record which address posted each
    //   individual update.
    // - Resolution is manual (`onlyOwner`), not an on-chain dispute system.
    //   `challengeUpdate`'s `updateTimestamp` is challenger-supplied and
    //   only enforced for the challenge-window check - this contract only
    //   retains each token's *latest* oracle status, so it cannot itself
    //   verify a challenge's claimed timestamp against history. That
    //   verification, and the actual "was this update wrong" judgment, is
    //   the resolver's job, checked off chain against the real event log
    //   and the real RWA status endpoint - the same honest scope
    //   disclosure the design spec itself calls for.

    uint256 public constant CHALLENGE_WINDOW = 1 hours;
    uint256 public constant BOND_COOLDOWN = 1 hours;
    uint256 public constant SLASH_BPS = 2000; // 20%, matches Verity's precedent
    uint256 private constant BPS_DENOMINATOR = 10000;

    uint256 public updaterBond;
    uint256 public bondPostedAt;
    uint256 public openChallengeCount;
    uint256 public nextChallengeId = 1; // 0 is reserved to mean "no active challenge"

    struct Challenge {
        address token;
        uint256 updateTimestamp; // challenger-claimed timestamp of the specific update being challenged
        address challenger;
        uint256 submittedAt;
        bool resolved;
        bool upheld;
    }

    mapping(uint256 => Challenge) public challenges;
    /// @notice (token, updateTimestamp) -> the currently-active challengeId
    /// against that specific update, or 0 if none. Prevents a second
    /// challenge on the same update while one is still unresolved; cleared
    /// on resolution so the same update can be re-challenged afterward if
    /// the first challenge was dismissed and new evidence surfaces.
    mapping(bytes32 => uint256) public activeChallengeForUpdate;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event MandateSet(uint256 maxNotionalPerTrade, uint256 maxTradesPerDay, uint256 expiry);
    event MandateRevoked();
    event TokenAllowlisted(address indexed token, bool allowed);
    event OracleUpdaterChanged(address indexed updater);
    event OracleUpdated(address indexed token, bool halted, uint256 updatedAt);

    event BondPosted(address indexed updater, uint256 amount, uint256 newBalance);
    event BondWithdrawn(address indexed updater, uint256 amount);

    /// @notice A challenge against a specific oracle update, identified by
    /// (token, updateTimestamp). `evidenceHash` is a keccak256 of whatever
    /// off-chain evidence the challenger is pointing at (e.g. the real RWA
    /// status API response fetched near that timestamp) - the hash is cheap
    /// to store and lets a resolver or judge confirm the evidence they're
    /// looking at is the exact evidence referenced, without paying to store
    /// the evidence itself on chain.
    event ChallengeSubmitted(
        uint256 indexed challengeId, address indexed challenger, address indexed token, uint256 updateTimestamp, bytes32 evidenceHash
    );
    event ChallengeResolved(uint256 indexed challengeId, bool upheld, uint256 slashedAmount);

    /// @notice Emitted on every guarded swap attempt, allowed or denied. This
    /// is the attestation: the thing a judge (or anyone) reads back from
    /// chain to independently verify what Covenant actually decided.
    event Attestation(
        address indexed caller,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bool allowed,
        DenialReason reason
    );

    // ---------------------------------------------------------------------
    // Errors (admin paths only - guard denials use Attestation, not reverts)
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotOracleUpdater();
    error ExpiryInPast();
    error ZeroAddress();
    error Reentrant();
    error BondCooldownActive();
    error OpenChallengesExist();
    error ChallengeWindowClosed();
    error UpdateAlreadyChallenged();
    error ChallengeDoesNotExist();
    error ChallengeAlreadyResolved();
    error TransferFailed();

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

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address _quoteToken, address _swapRouter, address _oracleUpdater, uint256 _stalenessBound) {
        if (_quoteToken == address(0) || _swapRouter == address(0) || _oracleUpdater == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        quoteToken = _quoteToken;
        swapRouter = _swapRouter;
        oracleUpdater = _oracleUpdater;
        stalenessBound = _stalenessBound;
        emit OracleUpdaterChanged(_oracleUpdater);
    }

    // ---------------------------------------------------------------------
    // Owner administration
    // ---------------------------------------------------------------------

    /// @notice Set (or replace) the active mandate. Overwrites whatever was there before.
    function setMandate(uint256 maxNotionalPerTrade, uint256 maxTradesPerDay, uint256 expiry) external onlyOwner {
        if (expiry <= block.timestamp) revert ExpiryInPast();
        mandate = Mandate({active: true, maxNotionalPerTrade: maxNotionalPerTrade, maxTradesPerDay: maxTradesPerDay, expiry: expiry});
        emit MandateSet(maxNotionalPerTrade, maxTradesPerDay, expiry);
    }

    /// @notice Deactivate the mandate immediately, without waiting for expiry.
    function revokeMandate() external onlyOwner {
        mandate.active = false;
        emit MandateRevoked();
    }

    /// @notice Allow or disallow a specific token address for trading. Always
    /// the exact provider-pinned address - there is deliberately no
    /// ticker-to-address resolution on chain, because that resolution step is
    /// exactly where provider confusion (NVDAB vs NVDAon) and scam tokens get
    /// injected. Resolve off chain, pin the address here.
    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit TokenAllowlisted(token, allowed);
    }

    function setOracleUpdater(address updater) external onlyOwner {
        if (updater == address(0)) revert ZeroAddress();
        oracleUpdater = updater;
        emit OracleUpdaterChanged(updater);
    }

    /// @notice Recover a token accidentally sent directly to this contract.
    /// Covenant is non-custodial by design during normal operation (see
    /// contract-level docs), so the only way a balance ends up here is a
    /// mistaken direct transfer - this exists so that mistake isn't permanent.
    function rescueToken(address token, uint256 amount, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).transfer(to, amount);
    }

    // ---------------------------------------------------------------------
    // Oracle
    // ---------------------------------------------------------------------

    /// @notice Push a halt/tradable status update for a token. Restricted to
    /// a single authorized updater address (set by the owner), fed from the
    /// RWA Data API off chain in Phase 2.
    function updateOracle(address token, bool halted) external onlyOracleUpdater {
        oracleStatus[token] = OracleStatus({halted: halted, updatedAt: block.timestamp});
        emit OracleUpdated(token, halted, block.timestamp);
    }

    // ---------------------------------------------------------------------
    // The guard
    // ---------------------------------------------------------------------

    /// @notice Propose a swap of `amountIn` of `quoteToken` into `tokenOut`.
    /// Covenant checks the mandate and the oracle; if both pass it pulls
    /// `amountIn` from the caller (who must have approved this contract
    /// first), forwards the swap to PancakeSwap, and sends the output
    /// straight to the caller. If either check fails, nothing is pulled and
    /// nothing is swapped - the call still succeeds, but only an Attestation
    /// with `allowed: false` is emitted.
    /// @param tokenOut The exact token address being bought. Must be
    /// allowlisted; there is no ticker resolution here on purpose.
    /// @param fee The PancakeSwap V3 pool fee tier (e.g. 2500 for 0.25%).
    /// @param amountIn Amount of `quoteToken` to spend, in its own decimals.
    /// @param amountOutMinimum Slippage floor passed straight to PancakeSwap.
    /// This is the caller's protection against price movement, not part of
    /// Covenant's mandate - a swap that reverts here reverts for real,
    /// because it is a DEX-level failure, not a guard decision.
    /// @return amountOut The amount of `tokenOut` received; 0 if denied.
    function guardedSwap(address tokenOut, uint24 fee, uint256 amountIn, uint256 amountOutMinimum)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        DenialReason reason = _evaluate(tokenOut, amountIn);
        if (reason != DenialReason.None) {
            emit Attestation(msg.sender, tokenOut, amountIn, 0, false, reason);
            return 0;
        }

        _recordTrade();

        IERC20(quoteToken).transferFrom(msg.sender, address(this), amountIn);
        // Reset to 0 first: some ERC20s (famously mainnet USDT) refuse to
        // change a non-zero allowance directly. BSC's USDT doesn't carry that
        // restriction (verified: it's a standard OZ-style ERC20), but paying
        // one extra SSTORE to not depend on that fact is the defensible
        // choice, not a maybe-unnecessary one.
        IERC20(quoteToken).approve(swapRouter, 0);
        IERC20(quoteToken).approve(swapRouter, amountIn);

        amountOut = IPancakeV3SwapRouter(swapRouter).exactInputSingle(
            IPancakeV3SwapRouter.ExactInputSingleParams({
                tokenIn: quoteToken,
                tokenOut: tokenOut,
                fee: fee,
                recipient: msg.sender,
                // Atomic single-transaction swap - `block.timestamp` is not a real
                // deadline constraint (it's always satisfied within this call), it's
                // just the value the real router's ABI requires here.
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        emit Attestation(msg.sender, tokenOut, amountIn, amountOut, true, DenialReason.None);
    }

    // ---------------------------------------------------------------------
    // Slashable oracle-accuracy guard
    // ---------------------------------------------------------------------

    /// @notice The oracle updater posts a bond, slashable if a challenge
    /// against one of their updates is upheld. Native BNB, not the quote
    /// token - keeps this independent of USDT allowance/approval plumbing.
    /// Restarts the cooldown on every deposit, including a top-up: capital
    /// added right before an anticipated challenge can't be withdrawn early.
    function postBond() external payable onlyOracleUpdater {
        updaterBond += msg.value;
        bondPostedAt = block.timestamp;
        emit BondPosted(msg.sender, msg.value, updaterBond);
    }

    /// @notice Withdraw the entire bond. Only the current oracle updater,
    /// only after the cooldown since the last deposit, and only with no
    /// unresolved challenges outstanding.
    function withdrawBond() external onlyOracleUpdater nonReentrant {
        if (openChallengeCount > 0) revert OpenChallengesExist();
        if (block.timestamp < bondPostedAt + BOND_COOLDOWN) revert BondCooldownActive();
        uint256 amount = updaterBond;
        updaterBond = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Challenge a specific past oracle update for `token`, claimed
    /// to have happened at `updateTimestamp`. Anyone can challenge - no
    /// stake required to submit one, since the resolver (not this function)
    /// is what actually protects against frivolous challenges. Reverts if
    /// the challenge window since `updateTimestamp` has already closed, or
    /// if that exact update already has an unresolved challenge against it.
    /// @param evidenceHash keccak256 of the off-chain evidence being
    /// referenced (e.g. a fetched RWA status API response near that time) -
    /// stored so a resolver or judge can confirm the evidence they're shown
    /// later is the exact evidence originally pointed at.
    function challengeUpdate(address token, uint256 updateTimestamp, bytes32 evidenceHash)
        external
        returns (uint256 challengeId)
    {
        if (block.timestamp > updateTimestamp + CHALLENGE_WINDOW) revert ChallengeWindowClosed();
        bytes32 key = keccak256(abi.encodePacked(token, updateTimestamp));
        if (activeChallengeForUpdate[key] != 0) revert UpdateAlreadyChallenged();

        challengeId = nextChallengeId++;
        activeChallengeForUpdate[key] = challengeId;
        challenges[challengeId] = Challenge({
            token: token,
            updateTimestamp: updateTimestamp,
            challenger: msg.sender,
            submittedAt: block.timestamp,
            resolved: false,
            upheld: false
        });

        openChallengeCount += 1;
        emit ChallengeSubmitted(challengeId, msg.sender, token, updateTimestamp, evidenceHash);
    }

    /// @notice Resolve a challenge. Deliberately manual/operator-adjudicated
    /// (owner-only), not an on-chain dispute system - see the storage-section
    /// comment above for why that's a disclosed simplification, not faked
    /// decentralization. If upheld, slashes `SLASH_BPS` of whatever the bond
    /// *currently* holds (never a fixed amount), so a second slash after an
    /// earlier one can never underflow - it just slashes a smaller absolute
    /// amount, gracefully, including down to zero.
    function resolveChallenge(uint256 challengeId, bool upheld) external onlyOwner nonReentrant {
        if (challengeId == 0 || challengeId >= nextChallengeId) revert ChallengeDoesNotExist();
        Challenge storage c = challenges[challengeId];
        if (c.resolved) revert ChallengeAlreadyResolved();

        c.resolved = true;
        c.upheld = upheld;
        openChallengeCount -= 1;
        bytes32 key = keccak256(abi.encodePacked(c.token, c.updateTimestamp));
        activeChallengeForUpdate[key] = 0;

        uint256 slashed = 0;
        if (upheld) {
            slashed = (updaterBond * SLASH_BPS) / BPS_DENOMINATOR;
            updaterBond -= slashed;
            if (slashed > 0) {
                (bool ok,) = c.challenger.call{value: slashed}("");
                if (!ok) revert TransferFailed();
            }
        }

        emit ChallengeResolved(challengeId, upheld, slashed);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Trades already recorded for the current UTC calendar day.
    function tradesUsedToday() public view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        return usage.day == today ? usage.count : 0;
    }

    /// @notice Read-only version of the guard's decision, for off-chain
    /// preview (e.g. `contract-call preview`) without spending gas on a
    /// state-changing call. Mirrors `_evaluate` exactly - if this and
    /// `guardedSwap` ever disagree, that is a bug in one of them.
    function previewDecision(address tokenOut, uint256 amountIn) external view returns (DenialReason) {
        return _evaluate(tokenOut, amountIn);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _evaluate(address tokenOut, uint256 amountIn) internal view returns (DenialReason) {
        Mandate memory m = mandate;
        if (!m.active) return DenialReason.MandateInactive;
        if (block.timestamp > m.expiry) return DenialReason.MandateExpired;
        if (!allowedTokens[tokenOut]) return DenialReason.TokenNotAllowed;
        if (amountIn > m.maxNotionalPerTrade) return DenialReason.NotionalExceeded;
        if (tradesUsedToday() >= m.maxTradesPerDay) return DenialReason.DailyLimitExceeded;

        OracleStatus memory status = oracleStatus[tokenOut];
        if (status.updatedAt == 0 || block.timestamp - status.updatedAt > stalenessBound) {
            return DenialReason.OracleStale;
        }
        if (status.halted) return DenialReason.OracleHalted;

        return DenialReason.None;
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

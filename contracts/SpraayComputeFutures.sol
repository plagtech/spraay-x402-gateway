// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SpraayComputeFutures
 * @notice Prepaid compute credit escrow for AI agents.
 *
 *   - Agent deposits USDC → contract holds it
 *   - Gateway operator calls drawdown() after each inference
 *   - Agent can refund() their remaining balance at any time
 *   - Spraay never holds agent funds — this contract does
 *
 * @dev Designed for Base mainnet with USDC (6 decimals).
 *      Gateway operator is the only address that can call drawdown().
 *      Depositors can always withdraw their own remaining balance.
 */
contract SpraayComputeFutures is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── State ─────────────────────────────────────────────

    IERC20 public immutable usdc;
    address public operator;       // Spraay gateway — can drawdown
    address public pendingOperator;

    struct Account {
        uint256 deposited;         // total USDC deposited (lifetime)
        uint256 balance;           // current available balance
        uint256 totalDrawn;        // total drawn down by operator
        uint256 totalRefunded;     // total refunded to depositor
        uint256 jobCount;          // number of drawdowns
        uint8 tier;                // 0=starter, 1=builder, 2=scale, 3=enterprise
        bool exists;
    }

    mapping(address => Account) public accounts;
    address[] public depositors;   // for enumeration

    // Tier thresholds (in USDC atomic units, 6 decimals)
    uint256 public constant TIER_BUILDER    = 10_000_000;    // $10
    uint256 public constant TIER_SCALE      = 50_000_000;    // $50
    uint256 public constant TIER_ENTERPRISE = 200_000_000;   // $200

    // Discount basis points per tier (100 = 1%)
    uint256 public constant DISCOUNT_STARTER    = 0;
    uint256 public constant DISCOUNT_BUILDER    = 500;   // 5%
    uint256 public constant DISCOUNT_SCALE      = 1000;  // 10%
    uint256 public constant DISCOUNT_ENTERPRISE = 1500;  // 15%

    // ── Events ────────────────────────────────────────────

    event Deposited(address indexed depositor, uint256 amount, uint256 newBalance, uint8 tier);
    event DrawnDown(address indexed depositor, uint256 amount, uint256 remaining, uint256 jobCount);
    event Refunded(address indexed depositor, uint256 amount, uint256 remaining);
    event OperatorTransferStarted(address indexed current, address indexed proposed);
    event OperatorTransferred(address indexed previous, address indexed newOperator);

    // ── Errors ────────────────────────────────────────────

    error OnlyOperator();
    error OnlyDepositor();
    error OnlyPendingOperator();
    error ZeroAmount();
    error InsufficientBalance(uint256 requested, uint256 available);
    error AccountNotFound();
    error ZeroAddress();

    // ── Constructor ───────────────────────────────────────

    /**
     * @param _usdc USDC token address (Base mainnet: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
     * @param _operator Spraay gateway operator address
     */
    constructor(address _usdc, address _operator) {
        if (_usdc == address(0) || _operator == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        operator = _operator;
    }

    // ── Modifiers ─────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator) revert OnlyOperator();
        _;
    }

    // ── Deposit ───────────────────────────────────────────

    /**
     * @notice Deposit USDC to create or top up a compute futures account.
     *         Agent must approve() this contract for the amount first.
     * @param amount USDC amount in atomic units (e.g. 50_000_000 = $50)
     */
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        Account storage acct = accounts[msg.sender];
        if (!acct.exists) {
            acct.exists = true;
            depositors.push(msg.sender);
        }

        acct.deposited += amount;
        acct.balance += amount;
        acct.tier = _computeTier(acct.balance);

        emit Deposited(msg.sender, amount, acct.balance, acct.tier);
    }

    // ── Drawdown (operator only) ──────────────────────────

    /**
     * @notice Deduct compute cost from an agent's balance and send to operator.
     *         Called by the Spraay gateway after each successful inference.
     * @param depositor Agent whose balance to deduct from
     * @param amount USDC amount to deduct (after discount, in atomic units)
     */
    function drawdown(address depositor, uint256 amount) external onlyOperator nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Account storage acct = accounts[depositor];
        if (!acct.exists) revert AccountNotFound();
        if (amount > acct.balance) revert InsufficientBalance(amount, acct.balance);

        acct.balance -= amount;
        acct.totalDrawn += amount;
        acct.jobCount += 1;
        acct.tier = _computeTier(acct.balance);

        // Send USDC directly to operator (Spraay gateway wallet)
        usdc.safeTransfer(operator, amount);

        emit DrawnDown(depositor, amount, acct.balance, acct.jobCount);
    }

    // ── Refund (depositor only) ───────────────────────────

    /**
     * @notice Withdraw all remaining balance back to the depositor.
     *         Can be called at any time — Spraay cannot block this.
     */
    function refund() external nonReentrant {
        Account storage acct = accounts[msg.sender];
        if (!acct.exists) revert AccountNotFound();

        uint256 remaining = acct.balance;
        if (remaining == 0) revert ZeroAmount();

        acct.balance = 0;
        acct.totalRefunded += remaining;
        acct.tier = 0;

        usdc.safeTransfer(msg.sender, remaining);

        emit Refunded(msg.sender, remaining, 0);
    }

    /**
     * @notice Withdraw a specific amount (partial refund).
     * @param amount USDC amount to withdraw
     */
    function refundPartial(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        Account storage acct = accounts[msg.sender];
        if (!acct.exists) revert AccountNotFound();
        if (amount > acct.balance) revert InsufficientBalance(amount, acct.balance);

        acct.balance -= amount;
        acct.totalRefunded += amount;
        acct.tier = _computeTier(acct.balance);

        usdc.safeTransfer(msg.sender, amount);

        emit Refunded(msg.sender, amount, acct.balance);
    }

    // ── View functions ────────────────────────────────────

    /**
     * @notice Get full account details for an agent.
     */
    function getAccount(address depositor) external view returns (
        uint256 balance,
        uint256 deposited,
        uint256 totalDrawn,
        uint256 totalRefunded,
        uint256 jobCount,
        uint8 tier,
        uint256 discountBps
    ) {
        Account storage acct = accounts[depositor];
        return (
            acct.balance,
            acct.deposited,
            acct.totalDrawn,
            acct.totalRefunded,
            acct.jobCount,
            acct.tier,
            _discountForTier(acct.tier)
        );
    }

    /**
     * @notice Check balance only.
     */
    function balanceOf(address depositor) external view returns (uint256) {
        return accounts[depositor].balance;
    }

    /**
     * @notice Get discount in basis points for a tier.
     */
    function getDiscount(uint8 tier) external pure returns (uint256) {
        return _discountForTier(tier);
    }

    /**
     * @notice Total USDC held by this contract.
     */
    function totalDeposits() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /**
     * @notice Number of unique depositors.
     */
    function depositorCount() external view returns (uint256) {
        return depositors.length;
    }

    // ── Operator management (2-step transfer) ─────────────

    /**
     * @notice Start operator transfer. New operator must accept.
     */
    function transferOperator(address newOperator) external onlyOperator {
        if (newOperator == address(0)) revert ZeroAddress();
        pendingOperator = newOperator;
        emit OperatorTransferStarted(operator, newOperator);
    }

    /**
     * @notice Accept operator transfer.
     */
    function acceptOperator() external {
        if (msg.sender != pendingOperator) revert OnlyPendingOperator();
        emit OperatorTransferred(operator, pendingOperator);
        operator = pendingOperator;
        pendingOperator = address(0);
    }

    // ── Internal ──────────────────────────────────────────

    function _computeTier(uint256 balance) internal pure returns (uint8) {
        if (balance >= TIER_ENTERPRISE) return 3;
        if (balance >= TIER_SCALE) return 2;
        if (balance >= TIER_BUILDER) return 1;
        return 0;
    }

    function _discountForTier(uint8 tier) internal pure returns (uint256) {
        if (tier == 3) return DISCOUNT_ENTERPRISE;
        if (tier == 2) return DISCOUNT_SCALE;
        if (tier == 1) return DISCOUNT_BUILDER;
        return DISCOUNT_STARTER;
    }
}

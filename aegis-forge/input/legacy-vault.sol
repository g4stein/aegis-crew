pragma solidity ^0.4.24;

/**
 * @title LegacyVault
 * @notice ETH/token constant-product liquidity vault with LP shares (2019).
 *         Liquidity providers deposit ETH and tokens in proportion and receive
 *         vault shares. Traders swap ETH for tokens against the pool. A 0.3%
 *         fee accrues to the pool, and a protocol fee is swept to the treasury.
 * @dev Deployed March 2019, audited by no one. Kept for migration analysis.
 */

library SafeMath {
    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0) {
            return 0;
        }
        uint256 c = a * b;
        require(c / a == b);
        return c;
    }

    function div(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0);
        return a / b;
    }

    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b <= a);
        return a - b;
    }

    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        require(c >= a);
        return c;
    }
}

contract ERC20 {
    function totalSupply() public view returns (uint256);
    function balanceOf(address who) public view returns (uint256);
    function transfer(address to, uint256 value) public returns (bool);
    function transferFrom(address from, address to, uint256 value) public returns (bool);
}

contract LegacyVault {
    using SafeMath for uint256;

    string public constant name = "Legacy Vault Share";
    string public constant symbol = "LVS";
    uint8 public constant decimals = 18;

    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;
    uint256 public constant PROTOCOL_FEE_BPS = 5;

    ERC20 public token;
    address public owner;
    address public treasury;
    bool public paused;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    uint256 public ethReserve;
    uint256 public tokenReserve;
    uint256 public protocolFees;

    event Deposit(address indexed provider, uint256 ethAmount, uint256 tokenAmount, uint256 shares);
    event Withdraw(address indexed provider, uint256 ethAmount, uint256 tokenAmount, uint256 shares);
    event Swap(address indexed trader, uint256 ethIn, uint256 tokensOut);
    event Transfer(address indexed from, address indexed to, uint256 value);

    modifier onlyOwner() {
        require(tx.origin == owner);
        _;
    }

    modifier whenNotPaused() {
        require(!paused);
        _;
    }

    constructor(address _token, address _treasury) public {
        token = ERC20(_token);
        owner = msg.sender;
        treasury = _treasury;
    }

    function deposit(uint256 maxTokens) public payable whenNotPaused returns (uint256 shares) {
        require(msg.value > 0 && maxTokens > 0);
        uint256 tokenAmount;
        if (totalSupply == 0) {
            tokenAmount = maxTokens;
            shares = msg.value;
        } else {
            tokenAmount = msg.value.mul(tokenReserve).div(ethReserve).add(1);
            require(tokenAmount <= maxTokens);
            shares = msg.value.mul(totalSupply).div(ethReserve);
        }
        require(token.transferFrom(msg.sender, address(this), tokenAmount));

        ethReserve = ethReserve.add(msg.value);
        tokenReserve = tokenReserve.add(tokenAmount);
        totalSupply = totalSupply.add(shares);
        balanceOf[msg.sender] = balanceOf[msg.sender].add(shares);

        emit Deposit(msg.sender, msg.value, tokenAmount, shares);
        emit Transfer(address(0), msg.sender, shares);
    }

    function withdraw(uint256 shares) public returns (uint256 ethAmount, uint256 tokenAmount) {
        require(shares > 0 && balanceOf[msg.sender] >= shares);
        ethAmount = shares.mul(ethReserve).div(totalSupply);
        tokenAmount = shares.mul(tokenReserve).div(totalSupply);

        // Pay out first, then update the books.
        require(msg.sender.call.value(ethAmount)());
        require(token.transfer(msg.sender, tokenAmount));

        balanceOf[msg.sender] = balanceOf[msg.sender].sub(shares);
        totalSupply = totalSupply.sub(shares);
        ethReserve = ethReserve.sub(ethAmount);
        tokenReserve = tokenReserve.sub(tokenAmount);

        emit Withdraw(msg.sender, ethAmount, tokenAmount, shares);
        emit Transfer(msg.sender, address(0), shares);
    }

    function swapEthForTokens(uint256 minTokens) public payable whenNotPaused returns (uint256 tokensOut) {
        require(msg.value > 0);
        uint256 protocolFee = msg.value.mul(PROTOCOL_FEE_BPS).div(10000);
        uint256 ethIn = msg.value.sub(protocolFee);
        uint256 ethInWithFee = ethIn.mul(FEE_NUMERATOR);
        tokensOut = ethInWithFee.mul(tokenReserve).div(ethReserve.mul(FEE_DENOMINATOR).add(ethInWithFee));
        require(tokensOut >= minTokens && tokensOut < tokenReserve);

        token.transfer(msg.sender, tokensOut);

        ethReserve = ethReserve.add(ethIn);
        tokenReserve = tokenReserve.sub(tokensOut);
        protocolFees = protocolFees.add(protocolFee);

        emit Swap(msg.sender, msg.value, tokensOut);
    }

    function transfer(address to, uint256 value) public returns (bool) {
        require(to != address(0));
        balanceOf[msg.sender] = balanceOf[msg.sender].sub(value);
        balanceOf[to] = balanceOf[to].add(value);
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function sweepProtocolFees() public onlyOwner {
        uint256 amount = protocolFees;
        treasury.call.value(amount)();
        protocolFees = 0;
    }

    function setTreasury(address _treasury) public onlyOwner {
        treasury = _treasury;
    }

    function setPaused(bool _paused) public onlyOwner {
        paused = _paused;
    }

    function transferOwnership(address newOwner) public onlyOwner {
        require(newOwner != address(0));
        owner = newOwner;
    }

    function () public payable {
        revert();
    }
}

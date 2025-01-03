import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
    buildWhirlpoolClient,
    PDAUtil,
    PoolUtil,
    SwapQuote,
    swapQuoteByInputToken,
    Whirlpool,
    WhirlpoolContext,
    WhirlpoolIx,
} from '@orca-so/whirlpools-sdk';
import { Wallet } from '@project-serum/anchor';
import { AddressUtil, Percentage, Wallet as OrcaWallet } from '@orca-so/common-sdk';
import BN from 'bn.js';
import {
    createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction,
    getAssociatedTokenAddress,
    NATIVE_MINT,
} from '@solana/spl-token';

const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');
const WHIRLPOOL_CONFIG_KEY = new PublicKey('FVG4oDbGv16hqTUbovjyGmtYikn6UBEnazz6RVDMEFwv');
const WHIRLPOOL_TICK_SPACING = 64;

export const MESSAGE_TOKEN_KEY = 'whirlpools-swap';

export function getWhirlpoolsContext(connection: Connection): WhirlpoolContext {
    // We use the context only for getting quotes and looking up instructions, so no need for real keypair
    const wallet = new Wallet(Keypair.generate());
    return WhirlpoolContext.from(connection, wallet as OrcaWallet, WHIRLPOOL_PROGRAM_ID);
}

export function getABMints(sourceMint: PublicKey, targetMint: PublicKey): [PublicKey, PublicKey] {
    const [addressA, addressB] = PoolUtil.orderMints(sourceMint, targetMint);
    return [AddressUtil.toPubKey(addressA), AddressUtil.toPubKey(addressB)];
}

function findCorrectPool(mintA: PublicKey, mintB: PublicKey): PublicKey {
    // usdc
    if ([mintA.toBase58(), mintB.toBase58()].includes('AKEWE7Bgh87GPp171b4cJPSSZfmZwQ3KaqYqXoKLNAEE')) {
        return new PublicKey('2FR5TF3iDCLzGbWAuejR7LKiUL1J8ERnC1z2WGhC9s6D');
    }

    // teth
    if ([mintA.toBase58(), mintB.toBase58()].includes('GU7NS9xCwgNPiAdJ69iusFrRfawjDDPjeMBovhV1d4kn')) {
        return new PublicKey('BqinHKam4jX8NUYbj2LsMnBYbqFnPvggiyx4PBHPkhSo');
    }

    // sol
    return new PublicKey('CFYaUSe34VBEoeKdJBXm9ThwsWoLaQ5stgiA3eUWBwV4');
}

export async function getPoolAndQuote(
    context: WhirlpoolContext,
    mintA: PublicKey,
    mintB: PublicKey,
    sourceMint: PublicKey,
    amount: BN,
    slippingTolerance: Percentage
): Promise<[Whirlpool, SwapQuote]> {
    const client = buildWhirlpoolClient(context);
    // pool account
    const whirlpoolKey = findCorrectPool(mintA, mintB);
    const whirlpool = await client.getPool(whirlpoolKey);
    const quote = await swapQuoteByInputToken(
        whirlpool,
        sourceMint,
        amount,
        slippingTolerance,
        WHIRLPOOL_PROGRAM_ID,
        context.fetcher
    );
    return [whirlpool, quote];
}

export async function getSwapInstructions(
    feePayer: PublicKey,
    user: PublicKey,
    context: WhirlpoolContext,
    whirlpool: Whirlpool,
    quote: SwapQuote,
    rentExemptBalance: number,
    associatedTokenAccountExists: boolean
): Promise<TransactionInstruction[]> {
    const associatedSOLAddress = await getAssociatedTokenAddress(NATIVE_MINT, user);
    const setupInstructions = associatedTokenAccountExists
        ? []
        : [createAssociatedTokenAccountInstruction(feePayer, associatedSOLAddress, user, NATIVE_MINT)];

    const data = whirlpool.getData();
    const swapInstructions = WhirlpoolIx.swapV2Ix(context.program, {
        ...quote,
        whirlpool: whirlpool.getAddress(),
        tokenMintA: whirlpool.getTokenAInfo().mint,
        tokenMintB: whirlpool.getTokenBInfo().mint,
        tokenOwnerAccountA: await getAssociatedTokenAddress(data.tokenMintA, user),
        tokenOwnerAccountB: await getAssociatedTokenAddress(
            data.tokenMintB,
            user,
            undefined,
            new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        ),
        tokenVaultA: data.tokenVaultA,
        tokenVaultB: data.tokenVaultB,
        tokenProgramA: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        tokenProgramB: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'),
        tokenAuthority: user,
        oracle: PDAUtil.getOracle(WHIRLPOOL_PROGRAM_ID, whirlpool.getAddress()).publicKey,
    }).instructions;

    const cleanupInstructions = [
        createCloseAccountInstruction(associatedSOLAddress, user, user),
        // createAssociatedTokenAccountInstruction transfers rent-exemption minimum from Octane to newly created token account.
        // when createCloseAccountInstruction sent the SOL output to user, it also included this rent-exemption minimum.
        SystemProgram.transfer({
            fromPubkey: user,
            toPubkey: feePayer,
            lamports: rentExemptBalance,
        }),
    ];

    return [...setupInstructions, ...swapInstructions, ...cleanupInstructions];
}

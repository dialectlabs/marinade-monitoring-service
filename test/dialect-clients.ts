import * as web3 from '@solana/web3.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import {
  createDialect,
  deleteDialect,
  getDialectForMembers,
  idl,
  Member,
  programs,
  sleep,
  Wallet_,
} from '@dialectlabs/web3';
import { DialectAccount } from '@dialectlabs/web3/lib/es';

const MONITORING_SERVICE_PUBLIC_KEY = process.env
  .MONITORING_SERVICE_PUBLIC_KEY as string;

const NETWORK_NAME = 'localnet';
const connection = new web3.Connection(
  programs[NETWORK_NAME].clusterAddress,
  'recent',
);

const DIALECT_PROGRAM_ADDRESS = programs[NETWORK_NAME].programAddress;
const createClients = async (n: number): Promise<void> => {
  console.log(
    `Creating ${n} dialect clients for:\n
    RPC URL:                 ${programs[NETWORK_NAME].clusterAddress}
    Solana network:          ${NETWORK_NAME}
    Dialect Program Address: ${DIALECT_PROGRAM_ADDRESS}
    Dapp public key:         ${MONITORING_SERVICE_PUBLIC_KEY}`,
  );

  const clients = Array(n)
    .fill(0)
    .map((it) => web3.Keypair.generate());

  // TO TEST with your own keypair,
  // comment out the clients array above, and use instead the following line:
  //const clients = Array(web3.Keypair.fromSecretKey(new Uint8Array([])));
  
  const wallet = Wallet_.embedded(clients[0].secretKey);
  // configure anchor
  anchor.setProvider(
    new anchor.Provider(connection, wallet, anchor.Provider.defaultOptions()),
  );
  const program = new anchor.Program(
    idl as anchor.Idl,
    new anchor.web3.PublicKey(DIALECT_PROGRAM_ADDRESS),
  );

  await fundKeypairs(program, clients);

  let dialectAccountsByPk: Record<
    string,
    { owner: Keypair; dialectAccount: DialectAccount }
  > = Object.fromEntries(
    await Promise.all(
      clients.map(async (owner) => {
        const members: Member[] = [
          {
            publicKey: new PublicKey(MONITORING_SERVICE_PUBLIC_KEY),
            scopes: [false, true],
          },
          {
            publicKey: owner.publicKey,
            scopes: [true, true],
          },
        ];
        const dialectAccount = await createDialect(program, owner, members);
        return [dialectAccount.publicKey.toString(), { owner, dialectAccount }];
      }),
    ),
  );

  process.on('SIGINT', async () => {
    const dialectAccounts = Object.values(dialectAccountsByPk);
    console.log(`Deleting dialects for ${dialectAccounts.length} clients`);
    await Promise.all(
      dialectAccounts.map(({ owner, dialectAccount }) =>
        deleteDialect(program, dialectAccount, owner),
      ),
    );
    console.log(`Deleted dialects for ${dialectAccounts.length} clients`);
    process.exit(0);
  });

  Object.values(dialectAccountsByPk).forEach(
    ({
      owner,
      dialectAccount: {
        dialect: { messages },
      },
    }) => {
      if (messages.length > 0) {
        console.log(
          `Got ${
            messages.length
          } new messages for '${owner.publicKey.toBase58()}: ${JSON.stringify(
            messages.map((it) => it.text),
          )}`,
        );
      }
    },
  );
  while (true) {
    const dialectAccounts = Object.values(dialectAccountsByPk);
    const dialectAccountsUpd: Record<
      string,
      { owner: Keypair; dialectAccount: DialectAccount }
    > = Object.fromEntries(
      await Promise.all(
        dialectAccounts.map(
          async ({
            owner,
            dialectAccount: {
              dialect: { members },
            },
          }) => {
            const dialectAccount = await getDialectForMembers(
              program,
              members,
            );
            return [
              dialectAccount.publicKey.toString(),
              { owner, dialectAccount },
            ];
          },
        ),
      ),
    );
    Object.values(dialectAccountsUpd).forEach(
      ({ owner, dialectAccount: { publicKey, dialect: newDialect } }) => {
        const {
          dialectAccount: { dialect: oldDialect },
        } = dialectAccountsByPk[publicKey.toString()];
        const newMessages = newDialect.messages.filter(
          ({ timestamp }) => timestamp > oldDialect.lastMessageTimestamp,
        );
        if (newMessages.length > 0) {
          console.log(
            `Got ${
              newMessages.length
            } new messages for '${owner.publicKey.toBase58()}: ${JSON.stringify(
              newMessages.map((it) => it.text),
            )}`,
          );
        }
      },
    );
    dialectAccountsByPk = dialectAccountsUpd;
    await sleep(1000);
  }
};

const fundKeypairs = async (
  program: anchor.Program,
  keypairs: web3.Keypair[],
  amount: number | undefined = 10 * web3.LAMPORTS_PER_SOL,
): Promise<void> => {
  await Promise.all(
    keypairs.map(async (keypair) => {
      const fromAirdropSignature =
        await program.provider.connection.requestAirdrop(
          keypair.publicKey,
          amount,
        );
      await program.provider.connection.confirmTransaction(
        fromAirdropSignature,
      );
    }),
  );
};

const main = async (): Promise<void> => {
  await createClients(2);
};

main();

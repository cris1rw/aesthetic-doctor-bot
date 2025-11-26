declare const Deno: {
  env: {
    get(key: string): string | undefined;
  };
  serve(
    handler: (req: Request) => Response | Promise<Response>
  ): Promise<void> | void;
};

declare module 'https://deno.land/x/postgresjs@v3.4.3/mod.js' {
  type SqlTaggedTemplate = <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T[]>;

  type PostgresClient = SqlTaggedTemplate & {
    end(config?: { timeout?: number }): Promise<void>;
  };

  const postgres: (
    connectionString: string,
    options?: Record<string, unknown>
  ) => PostgresClient;

  export default postgres;
}



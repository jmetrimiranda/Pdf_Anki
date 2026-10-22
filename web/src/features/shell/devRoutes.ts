/** /dev/* pages exist only in development builds and in the mocked build used by the e2e tests. */
export const devRoutesEnabled: boolean = import.meta.env.DEV || import.meta.env.VITE_MOCK === '1';

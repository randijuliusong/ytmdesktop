import { defineConfig, loadEnv } from 'vite';


// https://vitejs.dev/config
export default defineConfig(config => {
    const env = loadEnv(config.mode, process.cwd(), "");

    return {
        build: {
            outDir: ".vite/main",
            rolldownOptions: {
                external: ["xosms"],
                // Services and integrations are keyed by their class name, so a
                // mangled name collides with another one and the app refuses to
                // start. Keep the names the source declares.
                output: {
                    keepNames: true
                }
            }
        },
        define: {
            YTMD_UPDATE_FEED_OWNER: env.YTMD_UPDATE_FEED_OWNER ? JSON.stringify(env.YTMD_UPDATE_FEED_OWNER) : null,
            YTMD_UPDATE_FEED_REPOSITORY: env.YTMD_UPDATE_FEED_REPOSITORY ? JSON.stringify(env.YTMD_UPDATE_FEED_REPOSITORY) : null,
            YTMD_DISABLE_UPDATES: env.NODE_ENV !== "production",

            LASTFM_API_KEY: env.LASTFM_API_KEY ? JSON.stringify(env.LASTFM_API_KEY) : null,
            LASTFM_API_SECRET: env.LASTFM_API_SECRET ? JSON.stringify(env.LASTFM_API_SECRET) : null,
        }
    }
});

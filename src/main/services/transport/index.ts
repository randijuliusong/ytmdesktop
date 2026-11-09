import { app, session } from 'electron';
import log from 'electron-log';
import { spawnSync } from 'node:child_process';
import Service from '../service';
import ConfigStore from '../configstore';
import MemoryStore from '../memorystore';
import YTMViewManager from '../ytmviewmanager';
import { MemoryStoreSchema } from '~shared/store/schema';
import {
  DependencyConstructor,
  TransportMode,
  TransportState,
} from '~shared/types';

/**
 * Chooses how the app reaches YouTube Music and applies it to Chromium.
 *
 * Some networks filter *.youtube.com by the TLS SNI, which leaves TCP/443
 * unusable and HTTP/3 over UDP/443 the only way through. Others are happy
 * with the standard handshake. The transport setting says which one the app
 * should use, and "auto" decides by probing the standard handshake once at
 * startup.
 *
 * The decision has to reach Chromium's command line before the network stack
 * starts, so it happens during the pre-initialised lifecycle. The probes run
 * curl instead of the network stack of this process, because the process is
 * about to start its own and cannot answer a question about the network while
 * it is still starting up.
 *
 * QUIC mode never pins an address and never restarts the app. Reliability
 * comes from the keepalive loop below, and when the path stays broken, from
 * restarting Chromium's network service process, which rebuilds the QUIC
 * pools and the resolver cache inside the same app process.
 */
export default class Transport extends Service {
  public static override readonly dependencies: DependencyConstructor<Service>[] =
    [ConfigStore, MemoryStore<MemoryStoreSchema>, YTMViewManager];

  // Keep the QUIC connection alive: a filter that reaps the flow otherwise
  // ends the connection, Chromium marks QUIC broken for the origin and falls
  // back to a transport the filter blocks.
  private static readonly DEFAULT_QUIC_ORIGINS = [
    'music.youtube.com:443',
    'www.youtube.com:443',
  ];
  private static readonly DEFAULT_QUIC_FLAGS = [
    '--quic_max_retransmittable_on_wire_ping_count=8',
    '--quic_max_aggressive_retransmittable_on_wire_ping_count=8',
    '--quiche_reloadable_flag_quic_close_on_idle_timeout=false',
    '--quiche_reloadable_flag_quic_default_enable_5rto_blackhole_detection2=false',
    '--quiche_reloadable_flag_quic_fix_timeouts=true',
  ];

  private curlAvailable: boolean | null = null;
  private curlVersionOutput: string | null = null;

  // A QUIC session with no traffic dies within the idle window of the filter's
  // UDP state, and the next request then has to re-handshake a network that no
  // longer admits the flow. The keepalive pings the origins through the view's
  // own session so the connection stays established while the app sits idle.
  // A failing path usually heals by itself: Chromium retries the origin
  // internally as long as something keeps asking, which this loop does. When
  // the failure is persistent, the ladder restarts Chromium's network service
  // process (well under a minute apart) so it rebuilds the resolver cache and
  // the QUIC pools and hands out a current address. The app process, its
  // views and its windows are never touched.
  private static readonly KEEPALIVE_INTERVAL_MS = 20_000;
  private static readonly KEEPALIVE_URL =
    'https://music.youtube.com/generate_204';
  private static readonly SYSTEM_URL = 'https://www.gstatic.com/generate_204';
  /** The first failure streak step that restarts the network service. */
  private static readonly FIRST_NETWORK_RESTART = 3;
  /** How many further failures between additional network service restarts. */
  private static readonly NETWORK_RESTART_STEP = 3;
  /** Hard cap of network service restarts per hour to keep Chromium healthy. */
  private static readonly NETWORK_RESTARTS_PER_HOUR = 5;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private keepaliveFailures = 0;
  private networkRestartTimestamps: number[] = [];
  private sawMainFrameFailure = false;

  public override onPreInitialized() {
    const configStore = this.getDependency(ConfigStore);

    const mode = (configStore.get('network.transport') ??
      'quic') as TransportMode;
    const origins =
      configStore.get('network.quicOrigins') ?? Transport.DEFAULT_QUIC_ORIGINS;
    const quicFlags =
      configStore.get('network.quicFlags') ?? Transport.DEFAULT_QUIC_FLAGS;
    const probeTimeout =
      configStore.get('network.transportProbeTimeoutMs') ?? 1500;

    let effective: 'handshake' | 'quic' =
      mode === 'handshake' ? 'handshake' : 'quic';
    let probe: TransportState['probe'] = { reachable: true, ms: 0, error: '' };

    if (mode === 'auto') {
      const started = Date.now();
      const result = this.probeHandshake('music.youtube.com', probeTimeout);
      probe = {
        reachable: result.ok,
        ms: Date.now() - started,
        error: result.error,
      };
      // Without a client to probe with, the network is unknown: keep the
      // standard handshake, which is what an unfiltered network wants.
      effective = result.ok || result.unknown ? 'handshake' : 'quic';
      log.info(
        `Transport probe: handshake ${result.unknown ? 'not possible' : probe.reachable ? 'succeeded' : 'failed'} in ${probe.ms}ms, using ${effective}`,
      );
      if (result.unknown) {
        log.warn(
          'Transport: no client to probe the network with, keeping the standard handshake. Switch the transport to QUIC in the settings if YouTube does not load.',
        );
      }
    }

    const flags: string[] = [];

    if (effective === 'quic') {
      flags.push('--enable-quic');
      if (origins.length)
        flags.push(`--origin-to-force-quic-on=${origins.join(',')}`);
      flags.push(...quicFlags);
      // No address is pinned on purpose. Chromium resolves the origins itself,
      // its QUIC session pool walks the answer set, and the keepalive below
      // keeps the resolver cache and the pools fresh for as long as the app
      // runs, so the connection follows the network instead of betting on one
      // address at startup.
    } else {
      flags.push('--disable-quic');
    }

    for (const flag of flags) this.applyFlag(flag);

    log.info(
      `Transport: mode=${mode} effective=${effective} flags=${flags.join(' ') || 'none'}`,
    );

    const memoryStore = this.getDependency(MemoryStore<MemoryStoreSchema>);
    memoryStore.set('networkTransport', {
      mode,
      effective,
      probe,
      flags,
      address: '',
    } satisfies TransportState);
  }

  public override onInitialized() {
    log.info('Transport initialized');
  }

  public override onPostInitialized() {
    this.getDependency(YTMViewManager).on('load-errored', () => {
      this.sawMainFrameFailure = true;
      const error = this.getDependency(YTMViewManager).loadError;
      log.info(
        `Recorded a main-frame load failure (${error?.code}, ${error?.description}), waiting for the transport to recover and reloading the view`,
      );
    });
    this.scheduleKeepalive(Transport.KEEPALIVE_INTERVAL_MS);
    log.info('Transport: transport keepalive started');
  }

  public override onTerminated() {
    clearTimeout(this.keepaliveTimer ?? undefined);
    this.keepaliveTimer = null;
  }

  private scheduleKeepalive(delayMs: number) {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.keepaliveTimer = null;
      void this.runKeepalive();
    }, delayMs);
  }

  /**
   * Requests a URL over the view's own session so the keep-alive request shares
   * the same network context, QUIC pool and resolver rules as YouTube.
   */
  private runKeepalive() {
    const started = Date.now();
    const partition = app.isPackaged
      ? 'persist:ytmview'
      : 'persist:ytmview-dev';
    session
      .fromPartition(partition)
      .fetch(Transport.KEEPALIVE_URL, { signal: AbortSignal.timeout(10_000) })
      .then((response) =>
        this.onKeepaliveSuccess(response.status, Date.now() - started),
      )
      .catch((error: unknown) => this.onKeepaliveFailure(error))
      .finally(() => this.scheduleKeepalive(Transport.KEEPALIVE_INTERVAL_MS));
  }

  private onKeepaliveSuccess(status: number, ms: number) {
    if (this.keepaliveFailures > 0) {
      log.info(
        `Transport: keepalive recovered after ${this.keepaliveFailures} failures`,
      );
      this.keepaliveFailures = 0;
      this.networkRestartTimestamps = [];
    }
    if (this.sawMainFrameFailure) {
      this.sawMainFrameFailure =
        this.getDependency(YTMViewManager).recoverFromLoadFailure();
    }
    log.debug(`Transport: keepalive ${status} in ${ms}ms`);
  }

  private async onKeepaliveFailure(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // Tell a general loss of connectivity from a YouTube-only one: one normal
    // HTTPS request (TCP, no command-line forcing) to an unfiltered host. A
    // dead network cannot be repaired by the app, so it must not count into
    // the recovery ladder and must not churn the network service in a loop.
    try {
      await session
        .fromPartition(
          app.isPackaged ? 'persist:ytmview' : 'persist:ytmview-dev',
        )
        .fetch(Transport.SYSTEM_URL, { signal: AbortSignal.timeout(5_000) });
    } catch {
      log.info(
        `Transport: the system has no network (${this.keepaliveFailures > 0 ? `${this.keepaliveFailures} failed keepalive(s) before` : 'since startup'}), keeping the keepalive failures out of the recovery ladder`,
      );
      return;
    }

    this.keepaliveFailures += 1;
    log.warn(
      `Transport: keepalive failed ${this.keepaliveFailures} time(s): ${message}`,
    );

    const due =
      this.keepaliveFailures === Transport.FIRST_NETWORK_RESTART ||
      (this.keepaliveFailures > Transport.FIRST_NETWORK_RESTART &&
        (this.keepaliveFailures - Transport.FIRST_NETWORK_RESTART) %
          Transport.NETWORK_RESTART_STEP ===
          0);
    if (!due) return;

    const now = Date.now();
    this.networkRestartTimestamps = this.networkRestartTimestamps.filter(
      (t) => now - t < 60 * 60 * 1000,
    );
    if (
      this.networkRestartTimestamps.length >=
      Transport.NETWORK_RESTARTS_PER_HOUR
    ) {
      log.warn(
        'Transport: the network service restarts hit the hourly cap, waiting for the keepalive to bring the path back',
      );
      return;
    }

    this.restartNetworkService();
  }

  /**
   * Kills this app's Chromium network service utility process. Chromium
   * immediately respawns it with the same command line, which rebuilds the
   * DNS cache, every QUIC pool and the broken service state while the app
   * process, its views and its windows keep running.
   */
  private restartNetworkService() {
    // The pid column pattern is anchored to the fifth field so the pipeline's
    // own bash -c line (which contains the pattern text as an argument) can
    // never match and kill itself.
    const kill = spawnSync(
      'bash',
      [
        '-c',
        `ps axo pid,ppid,cmd | awk -v app=${process.pid} '$2==app && $5=="--utility-sub-type=network.mojom.NetworkService" {print $1}' | xargs -r kill -9`,
      ],
      { timeout: 5000 },
    );
    this.networkRestartTimestamps.push(Date.now());

    if (kill.status === 0) {
      log.warn(
        `Transport: the YouTube path keeps failing through the keepalive, restarting Chromium's network service to rebuild the QUIC pools`,
      );
    } else {
      log.error(
        `Transport: could not restart Chromium's network service (exit ${kill.status ?? 'signal'}): ${String(
          kill.stderr ?? '',
        )
          .trim()
          .slice(0, 200)}`,
      );
    }
  }

  /**
   * Reports whether the standard handshake reaches the host.
   *
   * A network that filters the SNI either refuses the connection or drops the
   * handshake, and both look like a failed request here, which is the answer
   * the transport choice needs.
   */
  private probeHandshake(
    host: string,
    timeoutMs: number,
  ): { ok: boolean; unknown: boolean; error: string } {
    if (!this.hasCurl()) return { ok: false, unknown: true, error: 'no curl' };

    const result = spawnSync(
      'curl',
      [
        '-4',
        '-s',
        '-o',
        '/dev/null',
        '-m',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        `https://${host}/`,
      ],
      { timeout: timeoutMs + 1000, stdio: 'ignore' },
    );

    return {
      ok: result.status === 0,
      unknown: false,
      error: result.status === 0 ? '' : `curl exit ${result.status}`,
    };
  }

  private hasCurl(): boolean {
    if (this.curlAvailable === null) {
      this.curlAvailable = this.curlVersion().length > 0;
    }
    return this.curlAvailable;
  }

  private curlVersion(): string {
    if (this.curlVersionOutput === null) {
      try {
        const result = spawnSync('curl', ['--version'], {
          timeout: 5000,
          encoding: 'utf8',
        });
        this.curlVersionOutput =
          result.status === 0 ? (result.stdout ?? '') : '';
      } catch {
        this.curlVersionOutput = '';
      }
    }
    return this.curlVersionOutput;
  }

  private applyFlag(flag: string) {
    const withoutDashes = flag.replace(/^--/, '');
    const separator = withoutDashes.indexOf('=');

    if (separator === -1) {
      app.commandLine.appendSwitch(withoutDashes);
    } else {
      app.commandLine.appendSwitch(
        withoutDashes.slice(0, separator),
        withoutDashes.slice(separator + 1),
      );
    }
  }
}

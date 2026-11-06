import { app } from "electron";
import log from "electron-log";
import tls from "node:tls";
import Service from "../service";
import ConfigStore from "../configstore";
import MemoryStore from "../memorystore";
import { MemoryStoreSchema } from "~shared/store/schema";
import { DependencyConstructor, TransportMode, TransportState } from "~shared/types";

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
 * starts, so it happens during the pre-initialised lifecycle.
 */
export default class Transport extends Service {
  public static override readonly dependencies: DependencyConstructor<Service>[] = [
    ConfigStore,
    MemoryStore<MemoryStoreSchema>
  ];

  // Keep the QUIC connection alive: a filter that reaps the flow otherwise ends
  // the connection, Chromium marks QUIC broken for the origin and falls back to
  // a transport the filter blocks.
  private static readonly DEFAULT_QUIC_ORIGINS = ["music.youtube.com:443", "www.youtube.com:443"];
  private static readonly DEFAULT_QUIC_FLAGS = [
    "--quic_max_retransmittable_on_wire_ping_count=8",
    "--quic_max_aggressive_retransmittable_on_wire_ping_count=8",
    "--quiche_reloadable_flag_quic_close_on_idle_timeout=false",
    "--quiche_reloadable_flag_quic_default_enable_5rto_blackhole_detection2=false",
    "--quiche_reloadable_flag_quic_fix_timeouts=true"
  ];

  public override onPreInitialized() {
    const configStore = this.getDependency(ConfigStore);

    const mode = (configStore.get("network.transport") ?? "quic") as TransportMode;
    const origins = configStore.get("network.quicOrigins") ?? Transport.DEFAULT_QUIC_ORIGINS;
    const quicFlags = configStore.get("network.quicFlags") ?? Transport.DEFAULT_QUIC_FLAGS;
    const probeTimeout = configStore.get("network.transportProbeTimeoutMs") ?? 1500;

    let effective: "handshake" | "quic" = mode === "handshake" ? "handshake" : "quic";
    let probe: TransportState["probe"] = { reachable: true, ms: 0, error: "" };

    if (mode === "auto") {
      probe = this.probeHandshake("music.youtube.com", probeTimeout);
      effective = probe.reachable ? "handshake" : "quic";
      log.info(`Transport probe: handshake ${probe.reachable ? "succeeded" : "failed"} in ${probe.ms}ms, using ${effective}`);
    }

    const flags: string[] = [];

    if (effective === "quic") {
      flags.push("--enable-quic");
      if (origins.length) flags.push(`--origin-to-force-quic-on=${origins.join(",")}`);
      flags.push(...quicFlags);
    } else {
      flags.push("--disable-quic");
    }

    for (const flag of flags) this.applyFlag(flag);

    log.info(`Transport: mode=${mode} effective=${effective} flags=${flags.join(" ") || "none"}`);

    const memoryStore = this.getDependency(MemoryStore<MemoryStoreSchema>);
    memoryStore.set("networkTransport", { mode, effective, probe, flags } satisfies TransportState);
  }

  public override onInitialized() {
    log.info("Transport initialized");
  }

  public override onPostInitialized() {}
  public override onTerminated() {}

  /**
   * Opens a TLS connection with the SNI of the host and reports whether the
   * handshake completed.
   *
   * A network that filters the SNI either refuses the connection or drops the
   * handshake, and both look like a failed handshake here, which is the answer
   * the transport choice needs.
   */
  private probeHandshake(host: string, timeoutMs: number): TransportState["probe"] {
    const started = Date.now();
    const result = { reachable: false, ms: 0, error: "" };
    const flag = new Int32Array(new SharedArrayBuffer(4));

    const settle = (error: string) => {
      result.reachable = error === "";
      result.ms = Date.now() - started;
      result.error = error;
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    };

    const socket = tls.connect(
      { host, port: 443, servername: host, timeout: timeoutMs, rejectUnauthorized: true },
      () => {
        socket.destroy();
        settle("");
      }
    );
    socket.on("error", error => settle((error as NodeJS.ErrnoException).code || error.message));
    socket.on("timeout", () => {
      socket.destroy();
      settle("TIMEOUT");
    });

    const deadline = Date.now() + timeoutMs + 500;
    while (Atomics.load(flag, 0) === 0 && Date.now() < deadline) {
      Atomics.wait(flag, 0, 0, 50);
    }

    if (Atomics.load(flag, 0) === 0) {
      socket.destroy();
      settle("TIMEOUT");
    }

    return result;
  }

  private applyFlag(flag: string) {
    const withoutDashes = flag.replace(/^--/, "");
    const separator = withoutDashes.indexOf("=");

    if (separator === -1) {
      app.commandLine.appendSwitch(withoutDashes);
    } else {
      app.commandLine.appendSwitch(withoutDashes.slice(0, separator), withoutDashes.slice(separator + 1));
    }
  }
}

import { app } from "electron";
import log from "electron-log";
import { spawnSync } from "node:child_process";
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
 * starts, so it happens during the pre-initialised lifecycle. The probes run
 * curl instead of the network stack of this process, because the process is
 * about to start its own and cannot answer a question about the network while
 * it is still starting up.
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

  private curlAvailable: boolean | null = null;
  private curlVersionOutput: string | null = null;

  public override onPreInitialized() {
    const configStore = this.getDependency(ConfigStore);

    const mode = (configStore.get("network.transport") ?? "quic") as TransportMode;
    const origins = configStore.get("network.quicOrigins") ?? Transport.DEFAULT_QUIC_ORIGINS;
    const quicFlags = configStore.get("network.quicFlags") ?? Transport.DEFAULT_QUIC_FLAGS;
    const probeTimeout = configStore.get("network.transportProbeTimeoutMs") ?? 1500;

    let effective: "handshake" | "quic" = mode === "handshake" ? "handshake" : "quic";
    let probe: TransportState["probe"] = { reachable: true, ms: 0, error: "" };
    let address = "";

    if (mode === "auto") {
      const started = Date.now();
      const result = this.probeHandshake("music.youtube.com", probeTimeout);
      probe = { reachable: result.ok, ms: Date.now() - started, error: result.error };
      // Without a client to probe with, the network is unknown: keep the
      // standard handshake, which is what an unfiltered network wants.
      effective = result.ok || result.unknown ? "handshake" : "quic";
      log.info(`Transport probe: handshake ${result.unknown ? "not possible" : probe.reachable ? "succeeded" : "failed"} in ${probe.ms}ms, using ${effective}`);
      if (result.unknown) {
        log.warn("Transport: no client to probe the network with, keeping the standard handshake. Switch the transport to QUIC in the settings if YouTube does not load.");
      }
    }

    const flags: string[] = [];

    if (effective === "quic") {
      flags.push("--enable-quic");
      if (origins.length) flags.push(`--origin-to-force-quic-on=${origins.join(",")}`);
      flags.push(...quicFlags);

      // YouTube answers on several anycast addresses and a filtered network
      // rejects some of them, so the first address the resolver hands out is
      // often a dead one. Pick an address that answers over HTTP/3 and point
      // Chromium at it.
      const selected = this.selectWorkingAddress("music.youtube.com", probeTimeout, 4);
      if (selected) {
        address = selected.ip;
        flags.push(`--host-resolver-rules=MAP music.youtube.com ${selected.ip}, MAP www.youtube.com ${selected.ip}`);
        log.info(`Transport: selected ${selected.ip} for the YouTube origins`);
      }
    } else {
      flags.push("--disable-quic");
    }

    for (const flag of flags) this.applyFlag(flag);

    log.info(`Transport: mode=${mode} effective=${effective} flags=${flags.join(" ") || "none"}`);

    const memoryStore = this.getDependency(MemoryStore<MemoryStoreSchema>);
    memoryStore.set("networkTransport", { mode, effective, probe, flags, address } satisfies TransportState);
  }

  public override onInitialized() {
    log.info("Transport initialized");
  }

  public override onPostInitialized() {}
  public override onTerminated() {}

  /**
   * Reports whether the standard handshake reaches the host.
   *
   * A network that filters the SNI either refuses the connection or drops the
   * handshake, and both look like a failed request here, which is the answer
   * the transport choice needs.
   */
  private probeHandshake(host: string, timeoutMs: number): { ok: boolean; unknown: boolean; error: string } {
    if (!this.hasCurl()) return { ok: false, unknown: true, error: "no curl" };

    const result = spawnSync(
      "curl",
      ["-4", "-s", "-o", "/dev/null", "-m", String(Math.max(1, Math.ceil(timeoutMs / 1000))), `https://${host}/`],
      { timeout: timeoutMs + 1000, stdio: "ignore" }
    );

    return { ok: result.status === 0, unknown: false, error: result.status === 0 ? "" : `curl exit ${result.status}` };
  }

  /**
   * Finds an address of the host that answers over HTTP/3.
   */
  private selectWorkingAddress(host: string, timeoutMs: number, maxAddresses: number): { ip: string; ms: number } | null {
    if (!this.hasHttp3Curl()) {
      log.info("Transport: no HTTP/3 client available, keeping the resolver's address");
      return null;
    }

    const started = Date.now();
    const addresses = this.resolveAddresses(host);

    if (!addresses.length) {
      log.info(`Transport: could not resolve ${host}`);
      return null;
    }

    log.info(`Transport: ${host} resolves to ${addresses.length} addresses, probing ${Math.min(addresses.length, maxAddresses)}`);

    for (const ip of addresses.slice(0, maxAddresses)) {
      const answers = this.answersOverHttp3(host, ip, timeoutMs);
      log.info(`Transport: ${ip} ${answers ? "answers over HTTP/3" : "does not answer"}`);
      if (answers) return { ip, ms: Date.now() - started };
    }

    return null;
  }

  private answersOverHttp3(host: string, ip: string, timeoutMs: number): boolean {
    const result = spawnSync(
      "curl",
      [
        "--http3-only",
        "-4",
        "-s",
        "-o",
        "/dev/null",
        "-m",
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        "--resolve",
        `${host}:443:${ip}`,
        `https://${host}/generate_204`
      ],
      { timeout: timeoutMs + 1000, stdio: "ignore" }
    );

    return result.status === 0;
  }

  /**
   * Resolves the addresses of the host without waiting on the event loop.
   */
  private resolveAddresses(host: string): string[] {
    const getent = spawnSync("getent", ["ahostsv4", host], { timeout: 5000, encoding: "utf8" });
    if (getent.status === 0 && getent.stdout) {
      const addresses = getent.stdout
        .split("\n")
        .map(line => line.trim().split(/\s+/)[0])
        .filter(address => /^\d+\.\d+\.\d+\.\d+$/.test(address));
      if (addresses.length) return [...new Set(addresses)];
    }

    const node = spawnSync(
      process.execPath,
      ["-e", "require('node:dns').promises.resolve4(process.argv[1]).then(a=>console.log(a.join('\\n'))).catch(()=>{})", host],
      { timeout: 5000, encoding: "utf8" }
    );
    if (node.status === 0 && node.stdout) {
      return node.stdout.split("\n").map(line => line.trim()).filter(address => /^\d+\.\d+\.\d+\.\d+$/.test(address));
    }

    return [];
  }

  private hasCurl(): boolean {
    if (this.curlAvailable === null) {
      this.curlAvailable = this.curlVersion().length > 0;
    }
    return this.curlAvailable;
  }

  /**
   * Whether the curl of this machine speaks HTTP/3.
   *
   * The Windows curl that ships with the system does not, so address probing
   * is skipped there and the resolver keeps its own choice.
   */
  private hasHttp3Curl(): boolean {
    return /HTTP3/.test(this.curlVersion());
  }

  private curlVersion(): string {
    if (this.curlVersionOutput === null) {
      try {
        const result = spawnSync("curl", ["--version"], { timeout: 5000, encoding: "utf8" });
        this.curlVersionOutput = result.status === 0 ? (result.stdout ?? "") : "";
      } catch {
        this.curlVersionOutput = "";
      }
    }
    return this.curlVersionOutput;
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

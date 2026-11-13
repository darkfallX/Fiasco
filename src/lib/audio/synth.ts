class SoundEngine {
  private ctx: AudioContext | null = null;
  private enabled = false;

  public isEnabled(): boolean {
    return this.enabled;
  }

  public setEnabled(next: boolean): void {
    this.enabled = next;
    if (next && typeof window !== "undefined") {
      this.ensureContext();
    }
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled || typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private tone(
    freqStart: number,
    freqEnd: number,
    durationSec: number,
    type: OscillatorType,
    gainPeak: number,
    delaySec = 0
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, now);
    if (freqEnd !== freqStart) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + durationSec);
    }

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(gainPeak, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + durationSec + 0.02);
  }

  public playStepTick(): void {
    this.tone(210, 110, 0.035, "triangle", 0.045);
  }

  public playHazardAlert(): void {
    this.tone(392, 294, 0.14, "sawtooth", 0.06, 0);
    this.tone(294, 220, 0.16, "sawtooth", 0.05, 0.13);
  }

  public playChargeHum(): void {
    this.tone(220, 330, 0.18, "sine", 0.06);
  }

  public playDeliveryPing(): void {
    this.tone(523.25, 523.25, 0.09, "triangle", 0.06, 0);
    this.tone(659.25, 659.25, 0.14, "triangle", 0.06, 0.08);
  }

  public playCheckpointOpen(): void {
    this.tone(440, 440, 0.08, "sine", 0.055, 0);
    this.tone(554.37, 554.37, 0.08, "sine", 0.055, 0.09);
    this.tone(659.25, 659.25, 0.18, "sine", 0.055, 0.18);
  }

  public playTradeFill(side: "YES" | "NO"): void {
    if (side === "YES") {
      this.tone(587.33, 783.99, 0.09, "triangle", 0.065);
    } else {
      this.tone(392, 293.66, 0.09, "triangle", 0.065);
    }
  }

  public playSettlement(anyWin: boolean): void {
    if (anyWin) {
      this.tone(440, 440, 0.12, "triangle", 0.06, 0);
      this.tone(554.37, 554.37, 0.12, "triangle", 0.06, 0.1);
      this.tone(659.25, 659.25, 0.28, "triangle", 0.07, 0.2);
    } else {
      this.tone(261.63, 220, 0.25, "sine", 0.06, 0);
    }
  }
}

export const soundEngine = new SoundEngine();

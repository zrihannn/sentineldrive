const PATTERNS = {
  siren: { label: 'Alternating siren', cycle: 1.02, notes: [{o:0,d:.44,a:690,b:1160,w:'triangle'},{o:.51,d:.44,a:1160,b:690,w:'triangle'}] },
  pulse: { label: 'Rapid warning pulses', cycle: .94, notes: [0,.22,.44,.66].map(o=>({o,d:.15,a:990,b:990,w:'square'})) },
  dual: { label: 'Dual-tone warning', cycle: 1.02, notes: [{o:0,d:.30,a:680,b:680,w:'sawtooth'},{o:.34,d:.30,a:1020,b:1020,w:'sawtooth'},{o:.68,d:.22,a:680,b:1020,w:'triangle'}] },
  urgent: { label: 'Urgent high-low', cycle: .96, notes: [{o:0,d:.19,a:540,b:540,w:'square'},{o:.23,d:.19,a:1120,b:1120,w:'square'},{o:.48,d:.19,a:540,b:540,w:'square'},{o:.72,d:.19,a:1120,b:1120,w:'square'}] }
};

export class AlarmEngine {
  constructor({ onState = () => {} } = {}) {
    this.onState = onState;
    this.context = null;
    this.master = null;
    this.enabled = true;
    this.tone = 'siren';
    this.volume = 90;
    this.active = false;
    this.previewing = false;
    this.silencedUntilClear = false;
    this.loopTimer = 0;
    this.previewTimer = 0;
  }
  async unlock() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;
    try {
      if (!this.context) {
        this.context = new AudioContextClass();
        this.master = this.context.createGain();
        this.master.gain.value = .0001;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') await this.context.resume();
      return this.context.state === 'running';
    } catch { return false; }
  }
  configure({ enabled = this.enabled, tone = this.tone, volume = this.volume } = {}) {
    this.enabled = enabled;
    this.tone = PATTERNS[tone] ? tone : 'siren';
    this.volume = Math.max(10, Math.min(100, Number(volume)));
    if (!enabled) this.stop();
    if (this.active) this.setLevel(.78 * this.volume / 100);
    this.emit();
  }
  setLevel(value, duration = .08) {
    if (!this.master || !this.context) return;
    const gain = this.master.gain, now = this.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(Math.max(.0001, gain.value), now);
    gain.linearRampToValueAtTime(Math.max(.0001, value), now + duration);
  }
  schedule(note, start) {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    const begin = start + note.o, end = begin + note.d;
    oscillator.type = note.w;
    oscillator.frequency.setValueAtTime(note.a, begin);
    if (note.a !== note.b) oscillator.frequency.linearRampToValueAtTime(note.b, end - .025);
    envelope.gain.setValueAtTime(.0001, begin);
    envelope.gain.linearRampToValueAtTime(.72, begin + .012);
    envelope.gain.setValueAtTime(.72, Math.max(begin + .018, end - .025));
    envelope.gain.linearRampToValueAtTime(.0001, end);
    oscillator.connect(envelope); envelope.connect(this.master);
    oscillator.start(begin); oscillator.stop(end + .01);
  }
  playCycle() {
    if (!this.active || !this.context || this.context.state !== 'running') return;
    const pattern = PATTERNS[this.tone], start = this.context.currentTime + .025;
    pattern.notes.forEach(note => this.schedule(note, start));
    this.loopTimer = window.setTimeout(() => this.playCycle(), pattern.cycle * 1000);
  }
  async start() {
    if (!this.enabled || this.silencedUntilClear || this.active) return;
    const ready = await this.unlock();
    if (!ready) { this.emit('Browser audio is blocked. Press Test tone once to enable it.'); return; }
    this.active = true;
    this.previewing = false;
    this.setLevel(.78 * this.volume / 100, .06);
    this.playCycle();
    this.emit();
  }
  async preview() {
    const ready = await this.unlock();
    if (!ready) { this.emit('Audio is unavailable. Check browser permissions.'); return; }
    if (this.active && !this.previewing) return;
    this.stop(false);
    this.active = true; this.previewing = true; this.setLevel(.78 * this.volume / 100, .05); this.playCycle();
    this.emit();
    this.previewTimer = window.setTimeout(() => this.stop(), 5000);
  }
  stop(clearSilence = true) {
    window.clearTimeout(this.loopTimer); window.clearTimeout(this.previewTimer);
    this.loopTimer = 0; this.previewTimer = 0;
    this.active = false; this.previewing = false;
    if (clearSilence) this.silencedUntilClear = false;
    this.setLevel(.0001, .12);
    this.emit();
  }
  silence() {
    this.silencedUntilClear = true;
    this.stop(false);
    this.emit('Alarm silenced until eyes reopen and a new event occurs.');
  }
  clearCondition() {
    this.silencedUntilClear = false;
    if (this.active && !this.previewing) this.stop();
  }
  emit(message = '') {
    this.onState({ active: this.active, previewing: this.previewing, enabled: this.enabled, tone: this.tone, label: PATTERNS[this.tone].label, silenced: this.silencedUntilClear, message });
  }
  destroy() { this.stop(); this.context?.close(); this.context = null; }
}

export const alarmPatterns = Object.entries(PATTERNS).map(([id, value]) => ({ id, label: value.label }));

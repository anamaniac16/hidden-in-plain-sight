// Runs the whole arms race headless, without the browser.
//   node tools/experiment.js [habitat] [species] [rounds]
// Prints the numbers the Findings page reports, so results can be checked
// and repeated.
require('../js/engine.js');
const C = globalThis.Camo;

const habitat = process.argv[2] || 'birch';
const species = process.argv[3] || 'moth';
const rounds = +(process.argv[4] || 4);
const MAX_GENS = 60;
const FOOLED = 0.1;

C.seed(7);
const hab = C.paintHabitat(habitat, 720, 432, 1234);
const net = C.createPredator();
const t0 = Date.now();

const fresh = () => Array.from({ length: 80 }, () => C.randomGenome());
const testRandom = fresh();

const train = (pool, steps) => {
  const tr = new C.Trainer(net, hab, species, pool, { steps });
  while (!tr.finished()) tr.run(50);
  return tr.losses.slice(-20).reduce((a, b) => a + b, 0) / 20;
};

const loss0 = train(() => C.randomGenome(), 500);
const naive = net.clone();
console.log(`naive predator trained: loss ${loss0.toFixed(3)} (${Date.now() - t0} ms)`);
console.log('  catches random creatures:', C.detectionRate(net, hab, species, testRandom).rate.toFixed(2),
  ' false alarms:', C.falseAlarmRate(net, hab).toFixed(2));

const archive = [];
let firstAttack = null;
for (let r = 1; r <= rounds; r++) {
  const evo = new C.Evolution();
  let st = evo.evaluate(net, hab, species);
  const start = st.detection;
  let gens = 0;
  while (st.detection > FOOLED && gens < MAX_GENS) {
    evo.nextGeneration();
    st = evo.evaluate(net, hab, species);
    gens++;
  }
  const evolved = evo.pop.map((i) => i.g);
  if (!firstAttack) firstAttack = evolved;
  const vsNaive = C.detectionRate(naive, hab, species, evolved).rate;
  console.log(`round ${r}: detection ${start.toFixed(2)} -> ${st.detection.toFixed(2)} in ${gens} gens` +
    ` | naive AI would catch ${vsNaive.toFixed(2)}`);
  archive.push(...evolved.slice(0, 18));
  const pool = () => {
    const u = Math.random();
    if (u < 0.5) return evolved[Math.floor(Math.random() * evolved.length)];
    if (u < 0.8) return archive[Math.floor(Math.random() * archive.length)];
    return C.randomGenome();
  };
  train(pool, 350);
  console.log(`   after hardening: catches this round's prey ${C.detectionRate(net, hab, species, evolved).rate.toFixed(2)}` +
    `, random ${C.detectionRate(net, hab, species, testRandom).rate.toFixed(2)}` +
    `, false alarms ${C.falseAlarmRate(net, hab).toFixed(2)}`);
}
console.log('hardened AI vs round-1 attack:', C.detectionRate(net, hab, species, firstAttack).rate.toFixed(2),
  ' naive AI vs round-1 attack:', C.detectionRate(naive, hab, species, firstAttack).rate.toFixed(2));
console.log(`total ${(Date.now() - t0) / 1000}s`);

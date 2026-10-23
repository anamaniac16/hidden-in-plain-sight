# Hidden in Plain Sight

**Can evolution hide from a neural network?**

A soft computing project that pits a **genetic algorithm** against a **neural network**.
The network is trained to spot creatures in a habitat. The genetic algorithm evolves
the creatures' colour patterns to slip past it. The creatures that survive show exactly
where the network is blind. The network is then retrained on them (adversarial training),
and the race starts again.

Everything runs in the browser in plain JavaScript. There is no ML library: the
multilayer perceptron, backpropagation, Adam and the genetic algorithm are all written
from scratch in [`js/engine.js`](js/engine.js).

## Why it matters

Vision AI can be fooled by patterns people would never notice:

- stickers on a stop sign read as a speed-limit sign (Eykholt et al., CVPR 2018)
- patterned glasses that fool face recognition (Sharif et al., CCS 2016)
- a printed T-shirt that hides its wearer from a person detector (Xu et al., ECCV 2020)

This project works like an automatic red team. Evolution searches for blind spots
using only the network's yes/no answers (a black-box attack). Each blind spot it finds
is used to make the network stronger, and the project measures how much harder the
hardened network is to fool.

## Running it

Open `index.html` in a browser. That's it. No install and no build step.

To serve it locally instead:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

To run the whole experiment without a browser (prints the numbers):

```bash
node tools/experiment.js birch moth 4
#                       habitat species rounds
```

## What's in the app

| Section | What it does |
| --- | --- |
| **Brief** | The problem, the idea, and the peppered moth: nature's own version of this experiment |
| **Lab** | Live arms race: evolve the prey, harden the AI, watch the detection rate saw up and down. Predator-vision heatmap, specimen drawer, gene inspector, and the network's first-layer weights |
| **Hunt** | Human vs AI: find 8 evolved creatures in 30 seconds, then watch the network scan the same image |
| **Findings** | A lab report written from the measurements in your session, plus a robustness test |
| **Method** | All parameters, the algorithm, syllabus concepts, references |

## Method

**Genetic algorithm (the prey)**

| | |
| --- | --- |
| Chromosome | 8 × 8 grid of RGB colours = 192 real-valued genes, stretched over the body shape |
| Population | 36 |
| Fitness | 1 − P(detected), averaged over 5 random spots; the network gets 3 shifted looks per spot and keeps its highest score |
| Selection | Tournament, size 3 |
| Crossover | 2D crossover (p = 0.85): a random rectangle of the pattern grid comes from the second parent |
| Mutation | Gaussian, rate 0.08, σ = 0.09, plus an occasional whole-channel colour drift |
| Elitism | 2 |

**Neural network (the predator)**

| | |
| --- | --- |
| Input | 32 × 32 window, averaged to 16 × 16, as opponent colour channels (brightness, red–green, blue–yellow) = 768 inputs |
| Architecture | MLP 768 → 64 → 24 → 1, ReLU hidden layers, sigmoid output |
| Training | Backpropagation, binary cross-entropy, Adam (lr 0.0015), batch 32, half positives |
| Hardening | 450 more steps; positives are 50% current survivors, 35% earlier survivors, 15% random creatures |

**The loop**

```
train predator on random creatures
repeat for each round:
    evolve prey until detection rate <= 10%   (a blind spot is found)
    retrain predator on the survivors          (adversarial training)
measure generations-to-fool before vs after hardening
```

## Sample results

One run on lichen birch bark with moths (numbers change from run to run):

| Round | Generations to fool the AI |
| --- | --- |
| 1 | 6 |
| 2 | 10 |
| 3 | 12 |
| 4 | 19 |

Robustness test (fresh random population attacking each network, 3 attacks):
the original network was fooled in 9.3 generations on average, the hardened one
needed 51.7+ (at least one attack gave up at 60).

The first creatures that fool the network are often colourful and easy for a person
to see. They are adversarial examples: the network's blind spots, not ours. After a few
rounds of hardening, evolution is pushed towards real camouflage.

## Files

```
index.html           page structure
css/style.css        styles
js/engine.js         habitats, creatures, neural network, genetic algorithm
js/app.js            interface, charts, lab, hunt, findings
tools/experiment.js  headless version of the experiment for Node
```

## References

1. Goodfellow, Shlens & Szegedy. *Explaining and Harnessing Adversarial Examples.* ICLR 2015.
2. Madry et al. *Towards Deep Learning Models Resistant to Adversarial Attacks.* ICLR 2018.
3. Eykholt et al. *Robust Physical-World Attacks on Deep Learning Visual Classification.* CVPR 2018.
4. Sharif et al. *Accessorize to a Crime.* ACM CCS 2016.
5. Xu et al. *Adversarial T-Shirt! Evading Person Detectors in a Physical World.* ECCV 2020.
6. Kettlewell. *Selection experiments on industrial melanism in the Lepidoptera.* Heredity, 1955.
7. Holland. *Adaptation in Natural and Artificial Systems.* 1975.

---

Anamika Dutta · B.Tech CSE (Data Science), Amity School of Engineering & Technology

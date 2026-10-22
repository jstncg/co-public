# Animation vocabulary

Source: **animations.dev** by Emil Kowalski — the course glossary. Justin adopted it on
2026-08-04 as kyo's binding motion language: **every animation discussion, comment, commit
message, and design note uses these terms.** If a motion has a name here, call it by that
name — "pop in", not "the bouncy appear thing"; "rubber-banding", not "it resists at the
edge". Naming is how motion gets reviewed instead of vibed.

DESIGN_SYSTEM.md §6 owns the *values* (which token, how long, which curve). This file owns
the *words*.

## Entrances & exits

| Term | Meaning |
|---|---|
| Fade in / out | Appears or disappears by changing opacity. |
| Slide in | Enters by sliding from off-screen (left, right, top, bottom). |
| Scale in | Grows from smaller to full size, usually paired with a fade. |
| Pop in | Appears with slight overshoot, like it bounces into place. |
| Reveal | Uncovered gradually, often by animating a clip-path or mask. |
| Enter / Exit | The animation played when added to or removed from the screen. |

## Sequencing & timing

| Term | Meaning |
|---|---|
| Keyframes | Defined points (0%, 50%, 100%) the runtime fills between. |
| Interpolation / Tween | Generating the in-between frames so motion is continuous. |
| Stagger | Several items animate one after another with a small delay — a cascade. |
| Orchestration | Timing multiple animations so they read as one coordinated motion. |
| Delay | Time before an animation starts. |
| Duration | How long an animation takes. |
| Fill mode | Whether an element keeps its first or last frame's styles outside the run. |
| Stepped animation | Divided into discrete steps, like a countdown. |

## Movement & transforms

| Term | Meaning |
|---|---|
| Translate | Move along X or Y. |
| Scale | Make bigger or smaller. |
| Rotate | Spin around a point. |
| Skew | Slant along X or Y, shearing out of its rectangle. |
| 3D tilt / Flip | Rotate in 3D (rotateX/rotateY) for depth. |
| Perspective | How strong the 3D effect looks; lower exaggerates depth. |
| Transform origin | The anchor point a scale or rotation grows or spins from. |
| Origin-aware animation | Animates out of its trigger (popover from its button), not its own center. |

## Transitions between states

| Term | Meaning |
|---|---|
| Crossfade | One element fades out as another fades in, same spot. |
| Continuity transition | Keeps the user oriented by visually connecting before and after. |
| Morph | One shape smoothly becomes another (Dynamic Island). |
| Shared element transition | An element travels and transforms from one position to another. |
| Layout animation | Size/position changes animate to the new spot instead of snapping. |
| Accordion / Collapse | A section smoothly expands and collapses its height. |
| Direction-aware transition | Slides one way forward, the opposite way back. |

## Scroll

| Term | Meaning |
|---|---|
| Scroll reveal | Elements fade or slide in as they enter the viewport. |
| Scroll-driven animation | Progress tied directly to scroll position. |
| Parallax | Background and foreground move at different speeds. |
| Page transition | Plays when navigating between pages or routes. |
| View transition | The runtime morphs between two states or pages, connecting shared elements. |

## Feedback & interaction

| Term | Meaning |
|---|---|
| Hover effect | Visual change on cursor-over. |
| Press / Tap feedback | Subtle scale-down on press, so it feels physical. |
| Hold to confirm | A progress effect that fills while the user holds. |
| Drag | Moving an element by grabbing it, often with momentum on release. |
| Drag to reorder | Dragging items in a list while the others shift to make room. |
| Swipe to dismiss | Dragging an element off-screen to close it. |
| Rubber-banding | Resistance and snap-back when dragged past a boundary (the iOS overscroll feel). |
| Shake / Wiggle | Quick side-to-side jitter signaling error or rejected input. |
| Ripple | A circle expanding from the tap point. |

## Easing

| Term | Meaning |
|---|---|
| Easing | How speed changes over an animation. |
| Ease-out | Fast then slow. The default for UI and anything responding to the user. |
| Ease-in | Slow then fast. Usually avoided; feels sluggish. |
| Ease-in-out | Slow, fast, slow. For on-screen elements moving A → B. |
| Linear | Constant speed. Spinners and marquees only. |
| Cubic-bezier | A custom curve for precise control. |
| Asymmetric easing | Accelerates and decelerates at different rates; feels more alive. |

## Springs

| Term | Meaning |
|---|---|
| Spring | Physics-driven motion (tension, mass, damping) instead of a fixed duration. |
| Stiffness / Tension | How strongly the spring pulls toward target. Higher = snappier. |
| Damping | How quickly it settles. Lower = more bounce and oscillation. |
| Mass | How heavy it feels. More mass = slower, more sluggish. |
| Bounce | A spring that overshoots and settles. Playful. |
| Perceptual duration | How long a spring *feels* finished, though it micro-settles underneath. |
| Momentum | Motion carrying velocity, especially after a drag. |
| Velocity | How fast and which way it's moving; a spring carries it into the next animation. |
| Interruptible animation | Can be smoothly redirected mid-flight instead of finishing first. |

## Looping & ambient motion

| Term | Meaning |
|---|---|
| Marquee | Content scrolling continuously in a loop. |
| Loop | Repeats, a set number of times or infinitely. |
| Alternate (yoyo) | Plays forward then reverses each iteration. |
| Orbit | One element circling another continuously. |
| Pulse | Gentle repeating scale or opacity change to draw attention. |
| Float | Gentle continuous drift; makes a static element feel weightless. |
| Idle animation | Subtle motion while an element waits to be interacted with. |

## Polish & effects

| Term | Meaning |
|---|---|
| Blur | Softens an element or masks tiny imperfections in a transition. |
| Clip-path | Clipping to a shape — reveals, masks, before/after sliders. |
| Mask | Like clip-path but with soft, fadeable edges. |
| Before / after slider | A draggable divider wiping between two overlaid images. |
| Line drawing | A path drawing itself in, like an invisible pen. |
| Text morph | Text animating character by character when it changes. |
| Skeleton / Shimmer | A placeholder with a moving sheen while content loads. |
| Number ticker | Digits rolling or counting up to a value. |
| Tabular numbers | Fixed-width digits so numbers don't shift. Essential for tickers and timers. |
| Typewriter | Text appearing one character at a time. |

## Performance

| Term | Meaning |
|---|---|
| Frame rate (FPS) | Frames per second. 60 is baseline, 120 on newer displays. |
| Jank | Visible stutter from dropped frames. |
| Dropped frame | A frame the runtime missed its deadline to draw. |
| Compositing | The GPU moving or fading a layer without redoing layout or paint. |
| will-change | A hint that an element is about to animate, so it gets its own layer early. |
| Layout thrashing | Animating width/height/top/left, forcing layout recalculation every frame. |
| Hardware acceleration | Animating transform and opacity so the GPU keeps motion smooth. |

## Principles

| Term | Meaning |
|---|---|
| Purposeful animation | Motion serves a function — orient, feedback, relationship — not decoration. |
| Anticipation | A small wind-up in the opposite direction before a move. |
| Follow-through | Parts keep moving and settle after the main motion stops, adding weight. |
| Squash & stretch | Deforming as it moves, to convey weight, speed, and flexibility. |
| Perceived performance | The right animation makes an interface feel faster than it is. |
| Frequency of use | The more often it's seen, the shorter and subtler it should be. |
| Spatial consistency | An element keeps its identity and position across states. |
| Reduced motion | Respect the user's setting — tone down or remove motion. |

## Where kyo already speaks it

- **Voice orb pull** (`KyoChatView`): drag + rubber-banding + squash & stretch, released
  into a spring with bounce; momentum decides the mode. Reduced motion keeps the drag,
  drops the deformation.
- **Contact block → orb** (`KyoChatView.setVoice`): a continuity transition — one element
  travels and grows, never a crossfade of two states.
- **Composer disc** (`KyoMotion.morph`): an interruptible morph, spring so it keeps
  velocity when re-triggered mid-flight.
- **Recording bar** (`KyoComposer`, `KyoLevelTrail`): one pill, two faces — a morph, not
  a crossfade. The trail tweens between 20Hz mic samples (interpolation), linear because
  it is continuous motion.
- **Sending a message** (`KyoChatView.thread`): slide in from below + a layout animation
  that pulls the new message to the top of the viewport — a continuity transition, so you
  never lose the question the answer belongs to.
- **Thinking row** (`KyoThinkingRow`): orbit + marquee shimmer + a tabular-number ticker,
  the animations.dev pixel loader with kyo's mascot in the wavefront's place.
- **Scroll edges** (`.scrollEdgeEffectStyle(.soft)`): the system's own mask.

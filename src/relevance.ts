import { DEFAULT_CONTEXT_BUDGETS, MIN_CONTEXT_MAX_TOKENS } from "./contextOutput.js";
import type { Domain } from "./types.js";

export type RelevantIntent =
  | "visual_appearance_check"
  | "screen_debug"
  | "time_pressure"
  | "current_work"
  | "focus_state"
  | "environment_check"
  | "writing_or_general_help"
  | "privacy_boundary"
  | "no_local_context_needed"
  | "general_context";

export type SnapshotMode =
  | "appearance_check"
  | "hair_check"
  | "outfit_check"
  | "lighting_check"
  | "desk_check"
  | "object_identification"
  | "screen_debug"
  | "ui_feedback"
  | "screen_summary"
  | "general_visual";

export type ExpectedContextValue = "none" | "low" | "medium" | "high";
export type ContextBudgetMode = "none" | "brief" | "focused" | "visual";

export interface ContextPlan {
  expected_value: ExpectedContextValue;
  budget: {
    mode: ContextBudgetMode;
    max_tokens: number;
  };
  plan_only: boolean;
  include_frame: boolean;
  include_situation: boolean;
  included_context: string[];
  excluded_context: string[];
  external_context_needed: string[];
  reason: string;
}

export interface RelevantContextPlan {
  intent: RelevantIntent;
  confidence: "high" | "medium" | "low";
  minimum_tool:
    | "none"
    | "get_context_frame"
    | "get_screen_context"
    | "get_user_state"
    | "get_environment_context"
    | "get_schedule_context"
    | "take_camera_snapshot"
    | "take_window_snapshot"
    | "take_full_screen_snapshot";
  relevant_domains: Domain[];
  recommended_tools: string[];
  follow_up_tools: string[];
  avoided_tools: string[];
  context_satisfied: boolean;
  requires_explicit_media: boolean;
  snapshot_mode?: SnapshotMode;
  context_plan: ContextPlan;
  guidance: string[];
  fallbacks: string[];
  privacy_notes: string[];
}

/**
 * The plan fields the router returns around any context it embeds: intent,
 * tools, guidance, fallbacks, privacy notes and this budget. `max_tokens` on a
 * Sense call is a ceiling on the *complete* response, so an advisory that only
 * covered the frame would quietly push `get_relevant_context` onto its degraded
 * output candidate, dropping guidance and privacy notes without an error.
 * Measured against docs/evals/real-frame-fixture.json the widest envelope any
 * branch produces is 476 tokens; this allowance rounds that up, and
 * `advisory budgets carry the real router envelope` in tests/relevance.test.ts
 * re-measures it so drift fails loudly instead of silently truncating.
 */
const ROUTER_ENVELOPE_TOKENS = 512;

/**
 * Advisory budgets the router hands back in `context_plan.budget.max_tokens`.
 * Clients echo this into the next Sense call, so each entry is the projection
 * default for the call that branch advises, plus the router envelope that call
 * carries when it goes back through `get_relevant_context`:
 *
 * - `focused` advises `get_context_frame`, which defaults to the focused
 *   projection over every domain (2204 tokens on the real-shaped fixture).
 * - `brief` advises a single-domain getter, which defaults to brief (at most
 *   1012 tokens on the same fixture).
 * - `visual` advises a snapshot tool. Those take no `max_tokens` at all, so the
 *   number describes the most context a client should pull alongside the
 *   capture: a compact frame, 888 tokens on the fixture.
 *
 * Every entry stays at or above the `MIN_CONTEXT_MAX_TOKENS` floor and below
 * the input schema's ceiling, which a test checks by parsing each one. Mode
 * `none` is plan-only: there is no follow-up call to budget for.
 */
function advisoryBudget(projectionBudget: number): number {
  return Math.max(MIN_CONTEXT_MAX_TOKENS, projectionBudget + ROUTER_ENVELOPE_TOKENS);
}

const ADVISORY_BUDGET_TOKENS: Record<ContextBudgetMode, number> = {
  none: 0,
  visual: advisoryBudget(DEFAULT_CONTEXT_BUDGETS.compact),
  brief: advisoryBudget(DEFAULT_CONTEXT_BUDGETS.brief),
  focused: advisoryBudget(DEFAULT_CONTEXT_BUDGETS.focused),
};

/**
 * Curly apostrophes macOS substitutes while typing. Unicode normalization does
 * not fold these onto U+0027, so the router does it explicitly; otherwise
 * "how’s my hair?" misses every possessive pattern below.
 */
const APOSTROPHE_VARIANTS = /[\u2018\u2019\u02bc\u201b]/g;

function normalizeRequest(userRequest: string): string {
  return userRequest.normalize("NFKC").replace(APOSTROPHE_VARIANTS, "'").toLowerCase();
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Sentences that announce themselves as questions about the world rather than
 * about this room: an explicit generalization, or a recommendation question.
 * No sensor reading can change the answer to "what is the best lighting setup
 * in general" or "what is the best lamp for my desk", so neither should be
 * recommended for one — the possessive in the second is about a purchase, not
 * about what is on the desk right now.
 */
function isGeneralizingFrame(text: string): boolean {
  return includesAny(text, [
    /\b(what|which)('?s| is| are) the (best|cheapest|right|ideal|top|most)\b/,
    /\bshould i buy\b/,
    /\bworth (buying|installing|getting|upgrading)\b/,
    /\bin general\b/,
    /\bgenerally\b/,
    /\bin principle\b/,
    /\bas a (rule|policy|habit|practice)\b/,
    /\b(typically|usually|normally)\b/,
    /\bbest practices?\b/,
    /\bgeneral (tips|advice|rules?|guidance|principles?)\b/,
    /\bfor (beginners|a beginner)\b/,
  ]);
}

/**
 * "How do I ...?" asks for a procedure. Around a bare topic noun that is the
 * general form of the question — "how do I improve my focus", "how do I keep my
 * desk tidy", "how do I keep my repo clean" — and a local reading cannot answer
 * it. This gate is deliberately not applied to the appearance branch, where
 * "how do I look?" is the request itself rather than a procedure question.
 */
function isHowToFrame(text: string): boolean {
  return /\bhow (do|can|could|should|would) (i|you|we)\b/.test(text);
}

/**
 * Nouns a demonstrative can be pointing at in the user's current situation. Up
 * to two adjectives may sit between them ("this disabled menu item"), but
 * "kind/sort/type of" may not: those turn the demonstrative into a class, not a
 * thing on the desk.
 */
const LOCAL_DEMONSTRATIVE_NOUN =
  /\b(this|these)\s+(?!(kind|sort|type|style|piece|part)\s+of\b)(?:[a-z-]+\s+){0,2}(screens?|windows?|pages?|apps?|ui|interfaces?|layouts?|designs?|errors?|dialogs?|buttons?|menus?|sidebars?|toolbars?|checkboxes?|dropdowns?|fields?|things?|objects?|files?|repos?|repositor(y|ies)|projects?|branch(es)?|commits?|prs?|tests?|tasks?|calls?|meetings?|shirts?|outfits?|rooms?|desks?|machines?|laptops?|setups?|docs?|documents?|notes?|photos?|videos?|recordings?)\b/;

/** "fix this", "what is this?", "these are broken" — the demonstrative is the object. */
const DEMONSTRATIVE_PRONOUN =
  /\b(this|these)\b(?=\s*$|\s*[?.!,;:]|\s+(is|are|was|were|looks?|seems?)\b)/;

/** "the current window", but not "the current thinking on open plan offices". */
const LOCAL_CURRENT_NOUN =
  /\bcurrent\s+(screen|window|page|app|project|repo|repository|work|context|session|task|state|file|branch|meeting|call|setup|environment)\b/;

/**
 * Markers that tie a request to the user's own current situation. Bare topic
 * nouns ("battery", "deadline", "workspace") only earn a sensor branch when one
 * of these is present; without it the request is general knowledge and local
 * context cannot change the answer.
 *
 * A bare "this"/"these"/"current" is not one of these markers. As a determiner
 * in front of any other noun it is ordinary English, and it was defeating this
 * gate on the exact sentence the comment above names: "what is the deadline for
 * filing taxes this year" is a tax question, not a fact about this user's
 * calendar. A demonstrative counts when it stands alone or points at something
 * the user is in front of. "should i" is gone for the same reason: it is a
 * deliberation about the future ("should I learn rust or go next", "should I
 * buy a laptop with better battery life"), not a statement about now. The
 * branches that legitimately key on it — workspace actions, next-step questions
 * — match it themselves, where the rest of the sentence is checked too.
 */
function hasLocalDeixis(text: string): boolean {
  return (
    includesAny(text, [
      /\bmy\b/,
      /\bmine\b/,
      /\bcurrently\b/,
      /\bright now\b/,
      /\bat the moment\b/,
      // Deictic time: "this afternoon" is as much about now as "right now" is,
      // and it is how people ask whether there is room in the rest of the day.
      /\bthis (morning|afternoon|evening)\b/,
      /\btonight\b/,
      /\bam i\b/,
      /\bi am\b/,
      /\bi'm\b/,
      /\bdo i\b/,
      /\bdid i\b/,
    ]) ||
    LOCAL_CURRENT_NOUN.test(text) ||
    DEMONSTRATIVE_PRONOUN.test(text) ||
    LOCAL_DEMONSTRATIVE_NOUN.test(text)
  );
}

function isWritingRequest(text: string): boolean {
  return includesAny(text, [
    /\bwrite\b/,
    /\bdraft\b/,
    /\brewrite\b/,
    /\bedit\b/,
    /\bemail\b/,
    /\bpost\b/,
    /\barticle\b/,
  ]);
}

/**
 * A topic noun points at the user's own situation only when the sentence is
 * about that situation. "my sidebar", "my desk", "my workspace" and "my focus"
 * are still topics inside a writing task, so every branch that reaches a sensor
 * through a bare noun plus deixis has to clear the writing gate as well. The
 * environment branch was gated this way from the start; the deictic branches
 * added later were not, which reintroduced the same false positive — and on the
 * physical-referent branch it reintroduced it on a camera capture.
 */
function isLocalTopicReference(text: string): boolean {
  return (
    hasLocalDeixis(text) &&
    !isWritingRequest(text) &&
    !isHowToFrame(text) &&
    !isGeneralizingFrame(text)
  );
}

/**
 * Predicates that make a body part, an outfit or a room the subject of "how
 * does it look right now?". A body-part noun on its own is not one: "my hair"
 * is the subject of "does my hair grow faster in summer?" and "my face" of
 * "what is the best sunscreen for my face", and neither asks for a camera.
 */
/**
 * A body-part possessive only asks for a camera when the body part is the head
 * of its clause — "how's my hair?", "my face looks tired". Any other noun after
 * it makes a compound topic instead ("my hair loss research notes", "my makeup
 * tutorial videos"), so this requires the clause to end or an appearance
 * predicate to follow, rather than blocklisting topic nouns one at a time.
 */
const BODY_PART_IS_CLAUSE_HEAD =
  /\bmy (hair|face|beard|makeup)\b(?=\s*[?.!,;]|\s*$|\s+(looks?|looking|is|are|isn't|seems?|got|gotten|today|right now|in this light|ok|okay|fine|alright|all right|decent|presentable|messy|a mess|frizzy|flat|weird|off|bad|awful|terrible|tired|puffy|shiny|greasy)\b)/;

function hasAppearancePredicate(text: string): boolean {
  return includesAny(text, [
    /\blooks?\b/,
    /\blooking\b/,
    /\b(ok|okay|fine|alright|all right|decent|presentable|acceptable|respectable)\b/,
    /\b(messy|a mess|frizzy|flat|sticking (up|out)|out of place|weird|off|bad|awful|terrible|tired|puffy|shiny|greasy)\b/,
    /\bcamera[- ]ready\b/,
  ]);
}

/**
 * "look" is a phrasal verb far more often than it is a question about the
 * user's face. "how do I look up a DNS record", "do I look for the file first"
 * and "how do I look at this problem differently" all reached a camera capture
 * through the bare openers below, so the particle that follows decides.
 */
const LOOK_PHRASAL_TAIL = /^\s+(up|into|through|after|for|at|over|around|past|beyond)\b/;

/**
 * English separable phrasal verbs take their object between the verb and the
 * particle when that object is a pronoun: "look it up", "look them over",
 * "look these up". The tail check above only inspects the word immediately
 * after "look", so it catches "look up X" and misses "look X up" — which is
 * the obligatory order for a pronoun object, and reached a camera capture.
 */
const LOOK_SEPARATED_PARTICLE =
  /^\s+(it|them|these|those|this|that|him|her|us|one|ones)\s+(up|over|through|into|around|past|beyond)\b/;

/**
 * "on paper", "in writing" and friends turn an appearance question into a
 * metaphor about a document: "what do I look like on paper for this job" is
 * about a resume, and no camera can answer it.
 */
const LOOK_FIGURATIVE =
  /^\s+like\b[^?.!]*\b(on paper|on my resume|on my cv|in writing|on the page|in print)\b/;

function isSelfAppearanceLook(text: string): boolean {
  return [/\bhow do i look\b/, /\bdo i look\b/].some((opener) => {
    const match = opener.exec(text);
    if (match === null) return false;
    const tail = text.slice(match.index + match[0].length);
    return (
      !LOOK_PHRASAL_TAIL.test(tail) &&
      !LOOK_SEPARATED_PARTICLE.test(tail) &&
      !LOOK_FIGURATIVE.test(tail)
    );
  });
}

/**
 * A camera capture is the most invasive thing Sense can recommend, so every
 * route to one requires the sentence to be about how the user or their room
 * looks *right now* — never a topic noun that happens to name a body part, a
 * light or a recording, and never a procedure question about either.
 */
function isCurrentAppearanceRequest(text: string): boolean {
  if (isWritingRequest(text) || isGeneralizingFrame(text)) return false;

  // An explicit request to use the camera needs no other evidence — but "how do
  // I turn on the camera in Zoom" is a procedure question, not a request.
  if (
    !isHowToFrame(text) &&
    includesAny(text, [
      // ...and not a question about the camera as a piece of software or
      // hardware: "can you check the camera settings in OBS" is configuration.
      /\b(check|look at|take a look at|point|open|turn on|use) (the|my) (camera|webcam)\b(?!\s+(settings|permissions?|driver|app|resolution|quality|firmware|lens|price|angle))/,
      /\b(camera|webcam) check\b/,
      // "take a photo of me in front of the eiffel tower someday" is a plan for
      // a different camera in a different place.
      /\btake a (photo|picture|selfie) of me\b(?!\s+(in front of|at|near|by|when|someday|next|during))/,
    ])
  ) {
    return true;
  }

  if (isSelfAppearanceLook(text)) return true;

  if (
    // "what is a fit check on tiktok" is a definition question, so the
    // indefinite article disqualifies it.
    (includesAny(text, [/\boutfit check\b/, /\bfit check\b/]) &&
      !/\b(a|an|the) (outfit|fit) check\b/.test(text)) ||
    /\b(am i|do i)\b.*\bready (for|to)\b.*\b(call|meeting|recording|video)\b/.test(text)
  ) {
    return true;
  }

  // Body-part nouns, only under a predicate about how they look now. "how's my
  // hair?" carries the predicate in the question word itself. A following noun
  // turns the body part into a compound topic instead of the subject — "look at
  // my hair loss research notes" is reading, not a mirror.
  if (
    BODY_PART_IS_CLAUSE_HEAD.test(text) &&
    (hasAppearancePredicate(text) || /\bhow'?s my (hair|face|beard|makeup)\b/.test(text))
  ) {
    return true;
  }

  // Only the first-person "before I ..." form, and only when the sentence also
  // asks to be looked at. Bare "start recording" and "before recording" are how
  // anyone asks how a recording app works ("how do I start recording in
  // Zoom?"), and "what should I read before I hop on a plane" is not a camera
  // moment either; both reached one.
  if (
    /\bbefore i (start recording|record|go live|hop on|jump on|get on)\b/.test(text) &&
    includesAny(text, [
      /\b(improvement|improve|fix|check|look|appearance|presentable|camera|webcam|hair|outfit|lighting|background)\b/,
    ])
  ) {
    return true;
  }

  // Lighting is a topic noun like any other. "tips for lighting a video call"
  // and "what is the best lighting for my kitchen" are general-knowledge
  // questions that reached a camera capture through the bare-noun form; it only
  // describes the user's own lighting when the sentence is about the user's own
  // situation and about a call.
  return (
    isLocalTopicReference(text) &&
    /\bmy lighting\b/.test(text) &&
    includesAny(text, [/\b(call|meeting|recording|video|camera|webcam|zoom|stream)\b/])
  );
}

/**
 * Phrasings that say outright that the subject is on the display right now.
 * These are enough on their own: the sentence has already said where the thing
 * is.
 */
function hasExplicitScreenSubject(text: string): boolean {
  return includesAny(text, [
    /\bmy (full|entire|whole) screen\b/,
    /\bwhat am i (looking at|seeing)\b/,
    /\bwhat'?s visible\b/,
    /\bvisible on (the|my) screen\b/,
    /\bwhat should i click\b/,
    /\bwhat to click next\b/,
  ]);
}

/**
 * Deictic referents for something displayed. Every one of them is also how
 * people talk about a physical panel ("how do I clean my screen", "what size is
 * my screen"), about a document ("how do I cite this page"), or about software
 * in the abstract ("is this UI pattern common in banking apps") — so a referent
 * on its own is not a reason to photograph the display.
 */
function hasScreenReferent(text: string): boolean {
  return includesAny(text, [
    /\bmy screen\b/,
    // "on my screen" says the thing is displayed, which is nearly always a
    // reason to look — but not on its own: "why is there a dead pixel on my
    // screen" is about the panel, and it reached a window capture.
    /\bon (my|the) screen\b/,
    /\bon screen\b/,
    /\bthis screen\b/,
    /\bcurrent screen\b/,
    /\bthis ui\b/,
    /\bthis interface\b/,
    /\bthis layout\b/,
    /\bthis design\b/,
    /\bthis error\b/,
    /\bthis page\b/,
    /\bcurrent page\b/,
    /\bthis window\b/,
    /\bcurrent window\b/,
    // The App Store is not the app the user is in.
    /\bcurrent app\b(?!\s+store\b)/,
  ]);
}

/**
 * The look-and-report half: the sentence asks for what the display is showing
 * to be read back. Without one of these the referent above is being used as an
 * ordinary noun.
 */
function hasScreenInspectionCue(text: string): boolean {
  return includesAny(text, [
    /\b(look at|looking at|take a look|can you see|show me|walk me through|tell me)\b/,
    /\b(review|inspect|examine|summari[sz]e|describe|explain|diagnose|debug)\b/,
    /\bwhat('?s| is| are)\b[^?.!]{0,40}\b(wrong|going on|happening|blocker|issue|problem|broken|failing)\b/,
    /\bwhat('?s| is| are)\s+(this|that)\b/,
    // "what's on my screen?" is the request in its shortest form.
    /\bwhat('?s| is| are)\s+(on|showing|displayed|open)\b/,
    /\b(most likely|biggest|worst) (blocker|issue|problem|part)\b/,
    /\breadable\b/,
  ]);
}

/**
 * "How do I record my entire screen in QuickTime", "how do I screenshot my
 * whole screen on a mac": a procedure question about the display apparatus
 * itself. It names the screen because the procedure is about the screen, and
 * both of these reached a full-screen capture. A procedure question about what
 * the screen is showing ("how do I fix this error on my screen") is not in this
 * list, so it still routes.
 */
function isScreenDeviceProcedure(text: string): boolean {
  return (
    isHowToFrame(text) &&
    includesAny(text, [
      /\b(record|screenshot|screen ?shot|capture|share|cast|mirror|stream|print|clean|dim|rotate|resize|split|calibrate|connect)\b/,
    ])
  );
}

function isCurrentScreenRequest(text: string): boolean {
  if (isWritingRequest(text) || isGeneralizingFrame(text)) return false;
  if (isScreenDeviceProcedure(text)) return false;
  if (hasExplicitScreenSubject(text)) return true;
  if (hasScreenReferent(text) && hasScreenInspectionCue(text)) return true;
  // "page readable" is not a duplicate of "this page" / "current page":
  // "is the page readable at this size" names no deictic page and would
  // otherwise reach no branch at all. The determiner carries the gate instead:
  // a definite page is the one in front of the user, while the indefinite form
  // ("what makes a page readable for dyslexic readers") is general knowledge
  // and must not reach a capture.
  return !isHowToFrame(text) && /\b(the|this|my|current) page (is )?readable\b/.test(text);
}

function isExplicitFullScreenRequest(text: string): boolean {
  return includesAny(text, [
    /\b(full|entire|whole) screen\b/,
    /\bmain display\b/,
    /\bentire desktop\b/,
  ]);
}

function isAllDisplaysRequest(text: string): boolean {
  return /\ball (my )?displays\b/.test(text);
}

/**
 * Words that make a sentence a request to look at something and say what is
 * there. A place on its own is not one: "my desk" is the subject of "how should
 * I organize my desk?" and "what is a good desk height?" just as much as it is
 * of "what is this on my desk?", and only the last of those wants a camera.
 */
function isInspectionFrame(text: string): boolean {
  return includesAny(text, [
    // A bare "what is" is not an inspection frame. It opens most questions in
    // English, including "what is a good way to organize the cables on my desk"
    // and "what is the average humidity in my room" — both of which reached a
    // camera capture through this gate. An interrogative frames an inspection
    // only when it points at something present.
    /\bwhat('?s| is| are)\s+(this|that|these|those)\b/,
    /\bwhat('?s| is| are)\s+(on|in|behind|next to|around|under|sitting on)\b/,
    /\bwhat kind of\b[^?.!]{0,30}\b(this|that|these|those)\b/,
    /\bis (there )?(anything|something)\b/,
    /\banything (visibly|distracting|out of place)\b/,
    /\b(look at|looking at|take a look|describe|identify)\b/,
    // "tell me what" and "can you see" only frame an inspection when what
    // follows points at something present. "tell me what a good way to organize
    // my desk is" and "can you see a way to make my desk cheaper" are requests
    // for an opinion, and the bare verbs matched both.
    /\btell me what('?s| is| are)?\s+(this|that|these|those|on|behind|in front|under|is on|is behind)\b/,
    /\bcan you see\b(?!\s+(a way|any way|why|how|a reason|any reason|the (point|logic|problem)))/,
    /\bhow (do|does) (it|this|that|things?) look\b/,
  ]);
}

function isPhysicalDeicticRequest(text: string): boolean {
  if (isWritingRequest(text) || isGeneralizingFrame(text)) return false;
  // The camera only ever answers a question about the physical room, so the
  // sentence has to name the room. A bare demonstrative does not: "how do I
  // clone this object in JavaScript" and "how does this thing work under the
  // hood" reached a camera capture as bare demonstratives.
  const physicalPlace = includesAny(text, [
    /\bon my desk\b/,
    /\bin my room\b/,
    /\bbehind me\b/,
    /\bin front of me\b/,
    /\bnext to me\b/,
  ]);
  if (!physicalPlace) return false;
  return (
    isInspectionFrame(text) ||
    includesAny(text, [/\b(this|that) (thing|object)\b/])
  );
}

/**
 * Markers that put the question in the present. A decision about the rest of
 * today is schedule pressure; the same decision about the rest of the decade is
 * not.
 */
function hasPresentTimeMarker(text: string): boolean {
  return includesAny(text, [
    /\bright now\b/,
    /\bnow\b/,
    /\btoday\b/,
    /\btonight\b/,
    /\bthis (morning|afternoon|evening)\b/,
    /\bat the moment\b/,
    /\bcurrently\b/,
    /\bbefore (my|the|our|this) (next|call|meeting|deadline|standup)\b/,
  ]);
}

/**
 * A "what next" clause belongs to the user's own work only when nothing follows
 * it, or when what follows is the user's own.
 */
const EXTERNAL_SUBJECT_TAIL =
  /^\s+(in|of|for|after|when|if|with|on|at|about|during|once)\s+(?!my\b|me\b|us\b|our\b|this\b|these\b|here\b|the (repo|branch|code|project|pr|codebase)\b)/;

function clauseIsAboutOwnWork(text: string, clause: RegExp): boolean {
  const match = clause.exec(text);
  if (!match) return false;
  return !EXTERNAL_SUBJECT_TAIL.test(text.slice(match.index + match[0].length));
}

/**
 * "Finish the thing in front of me, quickly." The clause names the task the user
 * is on ("knock this out", "get it done") and an urgency adverb; either half on
 * its own is ordinary English ("get it done properly", "how do I learn this
 * quickly"), so both are required.
 */
function isFinishNowRequest(text: string): boolean {
  const finishing = includesAny(text, [
    /\b(knock|bang|crank|power|smash) (this|it|these|them) out\b/,
    /\bget (this|it|these|them) (done|finished|out the door)\b/,
    /\b(finish|complete) (this|it|these|them)\b/,
    /\bwrap (this|it|these|them) up\b/,
  ]);
  const urgent = includesAny(text, [
    /\b(fast|quickly|asap|right away|in a hurry|before i run out of time)\b/,
  ]);
  return finishing && urgent;
}

/**
 * "Is there room to start something large before the day runs out?" The size of
 * the task is the whole question, so this is schedule pressure and not a
 * question about what the work currently is.
 */
function isStartLargeTaskRequest(text: string): boolean {
  return (
    isLocalTopicReference(text) &&
    // "before the day runs out" is the whole question, so the sentence has to be
    // about now. Without this, "should I take on a big project in my twenties"
    // is a life question that reached the schedule sensors.
    hasPresentTimeMarker(text) &&
    /\b(start|starting|begin|beginning|take on|taking on|kick off|dive into)\b[^.?!]{0,24}\b(big|large|long|major|deep|heavy|substantial|serious|ambitious)\b/.test(
      text,
    )
  );
}

/**
 * A "now or later?" decision. The answer turns on what else is on the calendar,
 * which is exactly what the schedule domain knows.
 */
function isNowOrLaterRequest(text: string): boolean {
  return includesAny(text, [
    /\bnow or (wait|later|tomorrow|after|in the morning)\b/,
    /\b(wait|hold off) or (send|do|ship|post) (it|this) now\b/,
  ]);
}

function isTimePressureRequest(text: string): boolean {
  return includesAny(text, [
    /\bbefore my (next )?meeting\b/,
    /\bbefore (the|a|my) (call|meeting|deadline)\b/,
    /\bnext meeting\b/,
    /\btime pressure\b/,
    /\brunning out of time\b/,
    /\b(5|10|15|20|30|45|60)[ -]?minute\b/,
    /\bten[ -]?minute\b/,
    /\bin \d+ minutes?\b/,
    /\bquick plan\b/,
  ]) ||
    isFinishNowRequest(text) ||
    isStartLargeTaskRequest(text) ||
    isNowOrLaterRequest(text) ||
    // "deadline" is a bare topic noun: it only means schedule pressure when the
    // user is asking about their own calendar, not about tax filing dates. The
    // same is true of what is "coming up": the phrase is only about this user's
    // day when the sentence is about this user.
    (isLocalTopicReference(text) &&
      includesAny(text, [/\bdeadline\b/, /\bcoming up\b/, /\bupcoming\b/]));
}

/**
 * "Should I commit / run the tests / open a PR?" — a decision about an action on
 * the work the user has open right now. Whether it is a good idea depends on
 * local state (which project is active, whether there is uncommitted work), so
 * the frame can change the answer. Both halves are required: the decision frame
 * without the action is any opinion question, and the action verb without it is
 * general knowledge ("how do commit hooks work").
 */
const WORKSPACE_ACTION_VERBS = [
  /\bre-?run (the )?tests?\b/,
  /\brun (the )?tests?\b/,
  /\bcommit\b/,
  /\bpush\b/,
  /\bmerge\b/,
  /\brebase\b/,
  /\bdeploy\b/,
  /\bship\b/,
  /\bopen a (pr|pull request)\b/,
  /\brefactor\b/,
];

/**
 * What follows the verb when the verb is not about the work in progress:
 * "commit *to* a lease", "push *myself* harder", "ship *a* product". Each of
 * these is the same decision frame around a different sense of the same verb,
 * and each reached a full local context frame.
 */
const FOREIGN_ACTION_OBJECT = /^\s+(to|myself|yourself|ourselves|a|an|these|those|them|on|into|for)\b/;

/** ... unless the object is itself part of the user's work ("merge these branches"). */
const WORKSPACE_OBJECT =
  /\b(branch(es)?|prs?|pull requests?|repos?|code|changes?|tests?|commits?|main|master|feature|fix|migration|deps?|dependenc(y|ies)|packages?)\b/;

function actsOnOwnWork(text: string): boolean {
  return WORKSPACE_ACTION_VERBS.some((verb) => {
    const match = verb.exec(text);
    if (!match) return false;
    const tail = text.slice(match.index + match[0].length);
    if (!FOREIGN_ACTION_OBJECT.test(tail)) return true;
    return WORKSPACE_OBJECT.test(tail.trim().split(/\s+/).slice(0, 4).join(" "));
  });
}

function isWorkspaceActionRequest(text: string): boolean {
  if (isWritingRequest(text) || isGeneralizingFrame(text)) return false;
  return (
    includesAny(text, [/\bshould i\b/, /\bdo i need to\b/, /\bis it time to\b/]) &&
    actsOnOwnWork(text)
  );
}

/**
 * "What should I do next?" in its two other common shapes: picking between
 * modes of work, and asking for the next step. The next-step form is excluded
 * when the step belongs to a named external subject ("the next step in the
 * scientific method"), which is general knowledge.
 */
function isNextWorkStepRequest(text: string): boolean {
  if (isWritingRequest(text) || isGeneralizingFrame(text)) return false;
  if (
    includesAny(text, [/\b(choose|decide|pick) between\b/]) &&
    // The user's own choice, not how people choose in general.
    includesAny(text, [
      /\bhelp me\b/,
      /\b(what|which) should i\b/,
      /\bshould i\b/,
      /\bi can'?t decide\b/,
      /\blet'?s\b/,
    ]) &&
    includesAny(text, [
      /\bdebugging\b/,
      /\btesting\b/,
      /\bcoding\b/,
      /\bwriting\b/,
      /\badmin\b/,
      /\bemail\b/,
      /\bmeetings?\b/,
      /\btasks?\b/,
      /\bwork\b/,
    ])
  ) {
    return true;
  }
  // "the next step in the scientific method", "the next step after boiling the
  // pasta", "the next thing to do when a fuse blows": the step belongs to a
  // named subject, and no local context bears on it. A first-person attachment
  // ("for my refactor") is still the user's work. Only `in|of|for` were checked
  // before, so every other preposition walked a recipe question into a frame.
  return clauseIsAboutOwnWork(text, /\bnext (\w+ ){0,2}(step|move|action|thing to do)\b/);
}

function isCurrentWorkRequest(text: string): boolean {
  if (isGeneralizingFrame(text)) return false;
  return (
    includesAny(text, [
      /\bwhat am i working on\b/,
      /\bcurrent (project|repo|context|work|session|task)\b/,
    ]) ||
    // Same external-subject test as the next-step branch: "what should I do
    // next in the legend of zelda" is not a question about this workspace.
    clauseIsAboutOwnWork(text, /\bwhat should i (work on|do) next\b/) ||
    isWorkspaceActionRequest(text) ||
    isNextWorkStepRequest(text) ||
    // Bare workspace nouns are topics in most sentences ("monorepo tooling",
    // "workspace design"); they only point at local state under deixis.
    (isLocalTopicReference(text) &&
      includesAny(text, [/\bworkspace\b/, /\brepo\b/, /\bwhat project\b/]))
  );
}

/**
 * Deictic questions about something the user can see in an app right now.
 * These are answered from the pixel-free screen domain: the referent is named,
 * so there is no justification for capturing an image of it.
 */
function isOnScreenReferentRequest(text: string): boolean {
  return (
    isLocalTopicReference(text) &&
    includesAny(text, [
      /\bbutton\b/,
      /\bmenu item\b/,
      /\bdialog\b/,
      /\bdropdown\b/,
      /\bcheckbox\b/,
      /\btoolbar\b/,
      /\bsidebar\b/,
      /\btext field\b/,
      /\b(greyed|grayed) out\b/,
      /\bdisabled\b/,
    ])
  );
}

/**
 * "Where was I?" — resuming needs the active workspace, not a screenshot.
 * Once the clause is embedded, English puts the subject first ("remind me what
 * I was working on", "remind me where I left off"), and that is the commoner
 * phrasing, so both orders are matched. `/where i left off/` also covers the
 * "pick up | resume where I left off" variants without a second pattern.
 */
function isWorkspaceResumeRequest(text: string): boolean {
  // Same writing gate every other deictic branch carries: "write up where I
  // left off" and "draft a note about what I was working on" are writing tasks
  // about the workspace, not requests to go read it.
  if (isWritingRequest(text)) return false;
  return includesAny(text, [
    /\bwhere did i leave off\b/,
    /\bwhere i left off\b/,
    /\bwhere was i\b/,
    /\bwhat was i (doing|working on)\b/,
    /\bwhat i was (doing|working on)\b/,
    /\b(was|am) i in the middle of\b/,
  ]);
}

function isFocusStateRequest(text: string): boolean {
  if (isGeneralizingFrame(text)) return false;
  // "deep work" and "focus" are topic nouns in most sentences; require deixis.
  // The deixis gate now also excludes the procedure form, so "how do I improve
  // my focus while studying" no longer reads as a question about right now.
  if (includesAny(text, [/\bdeep work\b/, /\bfocus\b/]) && isLocalTopicReference(text)) return true;
  return includesAny(text, [
    /\bshould i work\b/,
    /\bgood state\b.*\b(work|focus)\b/,
    /\bmy state\b.*\b(work|focus|deep)\b/,
    /\bcurrent state\b.*\b(work|focus|deep)\b/,
    /\bactive or away\b/,
  ]);
}

function isExplicitContextRequest(text: string): boolean {
  return includesAny(text, [
    /\bwhat context\b/,
    /\bwhat can you see\b/,
    /\bwhat do you know about me right now\b/,
    /\bmy situation\b/,
    /\bmy current context\b/,
    /\bfit my situation\b/,
    /\bcapabilities\b.*\b(granted|denied|unavailable)\b/,
    /\bminimum sense tool\b/,
  ]);
}

function withDefaults(plan: Omit<RelevantContextPlan, "avoided_tools" | "context_satisfied" | "fallbacks" | "follow_up_tools" | "privacy_notes" | "requires_explicit_media" | "context_plan"> & {
  avoided_tools?: string[];
  context_satisfied?: boolean;
  fallbacks?: string[];
  follow_up_tools?: string[];
  privacy_notes?: string[];
  requires_explicit_media?: boolean;
  context_plan?: Partial<Omit<ContextPlan, "budget">> & {
    /** Branches pick the mode; `max_tokens` is always derived, never literal. */
    budget?: { mode: ContextBudgetMode };
  };
}): RelevantContextPlan {
  const usesCamera = plan.recommended_tools.includes("take_camera_snapshot");
  const usesWindow = plan.recommended_tools.includes("take_window_snapshot");
  const usesFullScreen = plan.recommended_tools.includes("take_full_screen_snapshot");
  const usesScreen = usesWindow || usesFullScreen;
  const planOnly = plan.minimum_tool === "none";
  const budgetMode: ContextBudgetMode =
    plan.context_plan?.budget?.mode ??
    (planOnly
      ? "none"
      : usesCamera || usesScreen
        ? "visual"
        : plan.minimum_tool === "get_context_frame"
          ? "focused"
          : "brief");
  const includedContext = [
    ...plan.relevant_domains.map((domain) => `${domain}_domain`),
    ...plan.recommended_tools,
  ];
  const excludedContext = [
    ...(plan.relevant_domains.includes("screen") ? [] : ["screen_domain"]),
    ...(plan.relevant_domains.includes("user") ? [] : ["user_domain"]),
    ...(plan.relevant_domains.includes("environment") ? [] : ["environment_domain"]),
    ...(plan.relevant_domains.includes("schedule") ? [] : ["schedule_domain"]),
    ...(usesCamera ? [] : ["camera_snapshot"]),
    ...(usesWindow ? [] : ["window_snapshot"]),
    ...(usesFullScreen ? [] : ["full_screen_snapshot"]),
  ];
  const contextPlan: ContextPlan = {
    expected_value: planOnly ? "none" : usesCamera || usesScreen ? "high" : "medium",
    plan_only: planOnly,
    include_frame: !planOnly,
    include_situation: !planOnly,
    included_context: includedContext,
    excluded_context: excludedContext,
    external_context_needed: [],
    reason:
      planOnly
        ? "Local context is unlikely to change the answer."
        : "Local context is likely to improve the answer or avoid a clarification.",
    ...plan.context_plan,
    budget: {
      mode: budgetMode,
      max_tokens: ADVISORY_BUDGET_TOKENS[budgetMode],
    },
  };

  return {
    ...plan,
    context_plan: contextPlan,
    context_satisfied: plan.context_satisfied ?? planOnly,
    follow_up_tools: plan.follow_up_tools ?? (planOnly ? [] : [...plan.recommended_tools]),
    avoided_tools:
      plan.avoided_tools ??
      [
        ...(usesCamera ? [] : ["take_camera_snapshot"]),
        ...(usesWindow ? [] : ["take_window_snapshot"]),
        ...(usesFullScreen ? [] : ["take_full_screen_snapshot"]),
        "take_screen_snapshot",
      ],
    requires_explicit_media: plan.requires_explicit_media ?? (usesCamera || usesScreen),
    fallbacks:
      plan.fallbacks ??
      ["If a recommended Sense capability is denied or unavailable, say exactly what is missing and answer from non-visual context only."],
    privacy_notes:
      plan.privacy_notes ??
      ["Use the minimum Sense tool needed. Do not capture camera or screen content unless the user made a current visual request."],
  };
}

export function planRelevantContext(userRequest: string): RelevantContextPlan {
  const text = normalizeRequest(userRequest);

  if (
    includesAny(text, [
      /\bread my messages?\b/,
      /\bread.*\b(dm|dms|slack|email|mail|inbox)\b/,
      /\b(read|copy|extract|show|tell me).*\b(password|passcode|2fa|otp|security code|credit card|ssn|api key|secret)\b/,
      /\bprivate messages?\b/,
      /\bwatch me\b/,
      /\bmonitor me\b/,
      /\binfer what i am typing\b/,
    ])
  ) {
    return withDefaults({
      intent: "privacy_boundary",
      confidence: "high",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      avoided_tools: [
        "take_camera_snapshot",
        "take_window_snapshot",
        "take_full_screen_snapshot",
        "take_screen_snapshot",
      ],
      guidance: [
        "Do not capture or read private messages, keystrokes, or ongoing screen content.",
        "Explain the privacy boundary and offer a safer alternative such as asking the user to paste selected text.",
      ],
      fallbacks: ["Use privacy-preserving guidance only; do not try a different Sense tool to bypass the boundary."],
      privacy_notes: ["Message contents, keystrokes, and background monitoring are outside the Sense privacy model."],
      context_plan: {
        expected_value: "none",
        plan_only: true,
        include_frame: false,
        include_situation: false,
        reason: "The request crosses a privacy boundary, so Sense should not collect local context.",
      },
    });
  }

  if (
    isWritingRequest(text) &&
    includesAny(text, [/\bdo not use camera\b/, /\bno camera\b/, /\bwithout (a )?screenshot\b/])
  ) {
    return withDefaults({
      intent: "writing_or_general_help",
      confidence: "high",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      avoided_tools: [
        "take_camera_snapshot",
        "take_window_snapshot",
        "take_full_screen_snapshot",
        "take_screen_snapshot",
      ],
      guidance: ["Do not use camera or screen tools for this writing request unless the user changes the request."],
      fallbacks: ["Proceed from the text the user supplied and ask for pasted context only if needed."],
      privacy_notes: ["The user explicitly constrained media use; honor that constraint."],
      context_plan: {
        expected_value: "none",
        plan_only: true,
        include_frame: false,
        include_situation: false,
        reason: "The user asked for writing help and explicitly constrained media use.",
      },
    });
  }

  if (isCurrentAppearanceRequest(text)) {
    const snapshotMode = /\bhair\b/.test(text)
      ? "hair_check"
      : /\boutfit\b|\bfit check\b/.test(text)
        ? "outfit_check"
        : /\blighting\b|\blight\b/.test(text)
          ? "lighting_check"
          : "appearance_check";

    return withDefaults({
      intent: "visual_appearance_check",
      confidence: "high",
      minimum_tool: "take_camera_snapshot",
      relevant_domains: ["user", "environment"],
      recommended_tools: ["take_camera_snapshot"],
      snapshot_mode: snapshotMode,
      guidance: [
        "Use an explicit camera snapshot because the user asked about current visual appearance.",
        "Inspect snapshot_path before answering.",
      ],
      fallbacks: [
        "If camera is disabled, tell the user to run sense-mcp enable camera or use the Sense panel.",
        "If capture is denied, point to macOS Camera privacy permissions.",
      ],
      privacy_notes: ["explicit camera use is justified only because this is a current visual appearance request."],
      context_plan: {
        expected_value: "high",
        budget: { mode: "visual" },
        include_frame: false,
        include_situation: false,
        included_context: ["camera_snapshot"],
        reason: "The user asked about current visual appearance; text context cannot answer that directly.",
      },
    });
  }

  if (isAllDisplaysRequest(text)) {
    return withDefaults({
      intent: "screen_debug",
      confidence: "high",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      guidance: [
        "Sense does not combine every display into one capture. Its full-screen tool captures only the main display.",
        "Ask the user to request the main display or identify individual app windows instead of implying all displays were captured.",
      ],
      fallbacks: ["Capture the main display or individual windows only after the user chooses that narrower scope."],
      privacy_notes: ["Do not widen a main-display or window consent receipt to other displays."],
      context_plan: {
        expected_value: "none",
        plan_only: true,
        include_frame: false,
        include_situation: false,
        reason: "The requested all-display capture is outside Sense's bounded media scope.",
      },
    });
  }

  if (isCurrentScreenRequest(text)) {
    const fullScreen = isExplicitFullScreenRequest(text);
    const screenTool = fullScreen ? "take_full_screen_snapshot" : "take_window_snapshot";
    return withDefaults({
      intent: "screen_debug",
      confidence: "high",
      minimum_tool: screenTool,
      relevant_domains: ["screen"],
      recommended_tools: [screenTool],
      snapshot_mode: includesAny(text, [/\bui\b/, /\bdesign\b/, /\blayout\b/])
        ? "ui_feedback"
        : fullScreen
          ? "screen_summary"
          : "screen_debug",
      guidance: [
        fullScreen
          ? "Use the higher-risk full-screen action only because the user explicitly asked for the entire main screen."
          : "Use a CoreGraphics window-id capture because the target app window is the subject and capture must not interrupt focus.",
        fullScreen
          ? "Require explicit full-screen confirmation before capture."
          : "Identify the target app window and pass its numeric CoreGraphics window id.",
        "Inspect snapshot_path before answering.",
      ],
      fallbacks: [
        fullScreen
          ? "If main-display capture is disabled, tell the user to run sense-mcp enable full-screen or use the Sense panel."
          : "If window capture is disabled, tell the user to run sense-mcp enable window or use the Sense panel.",
        "If capture is denied, point to macOS Screen Recording permissions.",
      ],
      privacy_notes: ["Avoid reading private messages or secrets from the screenshot; summarize only what is needed for the request."],
      context_plan: {
        expected_value: "high",
        budget: { mode: "visual" },
        include_frame: false,
        include_situation: false,
        included_context: [fullScreen ? "full_screen_snapshot" : "window_snapshot"],
        reason: fullScreen
          ? "The user explicitly requested the entire screen, so the higher-risk full-screen action is justified after confirmation."
          : "The user referenced current visible app content; capture only the identified app window without changing focus.",
      },
    });
  }

  if (isPhysicalDeicticRequest(text)) {
    return withDefaults({
      intent: "visual_appearance_check",
      confidence: "medium",
      minimum_tool: "take_camera_snapshot",
      relevant_domains: ["environment"],
      recommended_tools: ["take_camera_snapshot"],
      snapshot_mode: "desk_check",
      guidance: ["Use camera only if the user is referring to the physical room or desk."],
      privacy_notes: ["Camera use is only appropriate if the referent is physical, not on-screen/private content."],
      context_plan: {
        expected_value: "high",
        budget: { mode: "visual" },
        include_frame: false,
        include_situation: false,
        included_context: ["camera_snapshot"],
        reason: "The user referred to a physical object or room context.",
      },
    });
  }

  // "battery", "noise", "lighting" and friends are ordinary topic nouns. They
  // only describe the user's surroundings when the sentence is about the user's
  // own situation, so the bare nouns are gated on deixis and on not being a
  // writing task ("write a post about the best lighting for a home office").
  const bareEnvironmentTopic =
    isLocalTopicReference(text) &&
    includesAny(text, [
      /\bnoise\b/,
      /\bbattery\b/,
      /\bpower\b/,
      /\blighting\b/,
      /\benvironment\b/,
      /\bmedia\b/,
    ]);
  if (
    bareEnvironmentTopic ||
    includesAny(text, [
      /\bwhere am i\b/,
      /\bplugged in\b/,
      /\bsetup\b.*\b(long|work|block|call)\b/,
      /\blong work block\b/,
    ])
  ) {
    return withDefaults({
      intent: "environment_check",
      confidence: "medium",
      minimum_tool: "get_environment_context",
      relevant_domains: ["environment"],
      recommended_tools: ["get_environment_context"],
      guidance: ["Use ambient context only; avoid snapshots unless explicitly visual."],
      context_plan: {
        expected_value: "medium",
        budget: { mode: "brief" },
        reason: "Ambient context can answer the request without visual capture.",
      },
    });
  }

  if (isTimePressureRequest(text)) {
    return withDefaults({
      intent: "time_pressure",
      confidence: "high",
      minimum_tool: "get_schedule_context",
      relevant_domains: ["schedule", "user"],
      recommended_tools: ["get_schedule_context", "get_user_state"],
      guidance: ["Use schedule pressure and presence to size the recommendation."],
      fallbacks: [
        "If Sense calendar context is unavailable and the client has a direct calendar connector, use that connector for schedule timing.",
        "If no calendar connector is available, state that schedule pressure is unknown and size the advice from user state only.",
      ],
      context_plan: {
        expected_value: "high",
        budget: { mode: "focused" },
        external_context_needed: ["calendar_connector"],
        reason: "Schedule timing can change the recommendation; account calendar data may need a connector.",
      },
    });
  }

  if (isCurrentWorkRequest(text)) {
    return withDefaults({
      intent: "current_work",
      confidence: "high",
      minimum_tool: "get_context_frame",
      relevant_domains: ["screen", "user", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use active app, workspace state, and schedule pressure."],
      context_plan: {
        expected_value: "high",
        budget: { mode: "focused" },
        reason: "The user is asking about current work state, so local workspace and activity context can change the answer.",
      },
    });
  }

  if (isFocusStateRequest(text)) {
    return withDefaults({
      intent: "focus_state",
      confidence: "medium",
      minimum_tool: "get_context_frame",
      relevant_domains: ["user", "environment", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use user state, environment, and schedule pressure."],
      context_plan: {
        expected_value: "medium",
        budget: { mode: "focused" },
        reason: "The user is asking about focus or availability, which depends on local state.",
      },
    });
  }

  if (isOnScreenReferentRequest(text)) {
    return withDefaults({
      intent: "screen_debug",
      confidence: "medium",
      minimum_tool: "get_screen_context",
      relevant_domains: ["screen"],
      recommended_tools: ["get_screen_context"],
      guidance: [
        "The user named an on-screen control, so semantic screen context is enough.",
        "Do not capture an image; ask the user to describe or paste detail the screen domain does not carry.",
      ],
      fallbacks: [
        "If screen context is unavailable, ask which app and control the user means instead of capturing the screen.",
      ],
      privacy_notes: [
        "A named on-screen referent does not justify capture; use the pixel-free screen domain.",
      ],
      context_plan: {
        expected_value: "medium",
        reason: "The user referred to a control they can see; active app and window context can explain it without capture.",
      },
    });
  }

  if (isWorkspaceResumeRequest(text)) {
    return withDefaults({
      intent: "current_work",
      confidence: "medium",
      minimum_tool: "get_screen_context",
      relevant_domains: ["screen"],
      recommended_tools: ["get_screen_context"],
      guidance: ["Use active app and workspace context to reconstruct where the user stopped."],
      fallbacks: ["If screen context is unavailable, ask the user what they were last working on."],
      privacy_notes: [
        "Resuming work needs workspace metadata, not an image of the screen.",
      ],
      context_plan: {
        expected_value: "medium",
        reason: "The user is resuming work, so the active workspace tells us where they left off.",
      },
    });
  }

  if (isWritingRequest(text)) {
    return withDefaults({
      intent: "writing_or_general_help",
      confidence: "medium",
      minimum_tool: "none",
      relevant_domains: [],
      recommended_tools: [],
      guidance: ["Do not use Sense tools for ordinary writing unless the user references current local context."],
      fallbacks: ["Proceed from the text the user supplied and ask for pasted context only if needed."],
      privacy_notes: ["No current local context was required for this writing request."],
      context_plan: {
        expected_value: "none",
        plan_only: true,
        include_frame: false,
        include_situation: false,
        reason: "Ordinary writing help does not need local context.",
      },
    });
  }

  if (isExplicitContextRequest(text)) {
    return withDefaults({
      intent: "general_context",
      confidence: "medium",
      minimum_tool: "get_context_frame",
      relevant_domains: ["screen", "user", "environment", "schedule"],
      recommended_tools: ["get_context_frame"],
      guidance: ["Use semantic context only; avoid camera and screen snapshots unless separately justified."],
      context_plan: {
        expected_value: "medium",
        budget: { mode: "focused" },
        reason: "The user explicitly asked what local context is available.",
      },
    });
  }

  return withDefaults({
    intent: "no_local_context_needed",
    confidence: "low",
    minimum_tool: "none",
    relevant_domains: [],
    recommended_tools: [],
    guidance: ["No local Sense context is needed for this request."],
    fallbacks: ["Answer normally without calling additional Sense tools."],
    privacy_notes: ["Avoid collecting local context when the request is not about the user's current situation."],
    context_plan: {
      expected_value: "none",
      plan_only: true,
      include_frame: false,
      include_situation: false,
      reason: "The request is not about the current local situation.",
    },
  });
}

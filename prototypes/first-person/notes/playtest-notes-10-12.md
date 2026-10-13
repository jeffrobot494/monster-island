# Monster Cookout Complete Playtest Notes and Prospective Designs

October 12, 2026

This document records the full playtest session and develops the prospective designs discussed during it. The game needs more threatening and distinctive monsters, clearer controls and feedback, useful followers, and stronger reasons to care about the village. Exploration and climbing onto terrain already produced moments of enjoyment. The proposed direction connects exploration, monster hunting, village survival, and preparation for increasingly dangerous encounters.

The extracted notes retain the substantive observations, requests, alternatives, and uncertainties from the session. The assessment evaluates their implications and priorities. Prospective designs are recommendations, not approved implementation decisions. Open questions remain separate from confirmed observations.

## Extracted Playtest Notes

### Terrain grounding collision and visual coherence

The initial terrain diagnosis changed during play. At first, there seemed to be three independent issues: floating or insufficiently grounded terrain, the ability to walk through it, and its purple appearance. After climbing onto it, the player revised that to two main concerns. The gaps where varied terrain fails to meet the flat ground appear associated with strange collision, and the terrain needs an appearance that fits the world. The exact technical relationship between mesh grounding and collision remains unverified.

The collision sequence matters: the player entered terrain from outside, then encountered blocking surfaces after entering and did not know how to escape. This is more specific than an ordinary missing collider. Investigation should reproduce entry, entrapment, and exit at the transition between the flat ground and varied terrain. Purple terrain could require textures, a simple color change, or broader palette matching; the player did not settle on a particular material solution.

Climbing and running on top of terrain was enjoyable. Preserve that positive experience while fixing grounding and collision. A later overhang could not be climbed despite repeated attempts. Whether the overhang should be climbable is unresolved; the game needs to distinguish intended limitations from inconsistent traversal.

The sheep pen has a separate collision defect: its walls can be walked through. Repeated falls from the same cliff caused deaths at several points in the session, including during the monster generation discussion. These deaths are observations, not proof of a fall damage bug. They suggest a place worth reviewing for terrain readability, traversal expectations, and player awareness of danger.

### Controls feedback and text focus

Inventory access was unclear. The player discovered dodge by accident and had not known the button existed. Both mechanics need instruction or persistent discoverability. The minimap did successfully indicate a monster's position, and the sight of a villager being carried away provided a useful immediate objective. The player also briefly could not locate the village.

The prayer text box has a serious input focus problem. Typed letters still activate gameplay actions, opening the map and closing the window instead of remaining in the input field. The requested fix applies whenever a text box is open: key presses should be routed into the input state and away from gameplay. Explicit modal controls such as submitting or cancelling need intentional behavior rather than accidental overlap with ordinary movement or shortcuts.

Injuries are not communicated clearly enough. The player discovered a broken leg while exploring and later explicitly requested an indication when an injury occurs. The judgment timer was noticed at seven minutes and later at three or four minutes. Seven minutes felt unexplained; the later countdown was received positively. Record both reactions rather than treating every timer observation as a complaint.

### Round outcome and the motivation to engage

The player located a monster lair but found that monsters already had 60 points and were winning. The player tried to find and kill a monster, encountered Ralos, and believed a villager had at least been protected from being carried away. The monsters won that round. These events raise questions about scoring pace, objective explanation, and intervention opportunities, but do not establish a confirmed scoring defect.

The player explicitly said they did not care much about the unfolding events and mainly wanted to wander. Exploration has appeal; the larger objectives and relationships are not yet providing a strong reason to engage. The later hunting party, population, recurring monster, and village founding ideas offer possible ways to build those stakes.

### Multiplayer requirement

Online multiplayer was identified as an important requirement. Players should explore the island and fight its monsters with friends. This is a firm directional request, though the session did not define player limits, hosting, matchmaking, shared village ownership, or progression rules.

### Combat exploit and monster threat

The dominant combat strategy is walking backward while a monster approaches. The monster stops to perform its attack, and the player has left its range by the time the attack completes. This works against one monster and against multiple monsters if all approach from the front. The player tested two monsters simultaneously and defeated them using the same strategy. One regular melee attack ignited the player, which was interesting, but did not change the basic encounter pattern.

Monsters also take too many hits, but the player corrected the emphasis: the central problem is the universal, overpowered strategy. Reducing health alone would not address it. Monsters need new attacks, jumping, thrown objects, and behavior beyond running directly toward the player. The desired identity is fighting epic, impressive, scary creatures rather than many small, unintelligent enemies.

Monster raids currently benefit a competent player by bringing killable monsters close to the altar. They remove the need to locate targets and reduce the effort of transporting bodies. The player wants raids to be dangerous enough to reverse that convenience. Monster sounds prompted a strong spontaneous reaction, but no specific audio adjustment was requested; retain this as an audio review observation rather than inventing a confirmed sound defect.

Spear throwing feels inaccurate and needs improvement. This becomes particularly important if precision attacks against eyes and other weak points are central to hunting.

### Cyclops hunting design from the player

A Cyclops should throw objects, hide, sneak up on players, and ambush them. Finding and confronting it should feel like a hunt. If wounded, outnumbered, or uncertain of victory, it should retreat. Its enormous size should let it outrun a small group of humans.

The Cyclops should be faster, stronger, and have much longer reach than humans. The player suggested that a Cyclops charging from roughly 20 feet away should be nearly fatal unless the human immediately achieves a difficult eye hit or finds an environmental escape. Jumping from a cliff into water that the Cyclops refuses to enter was an example, not a universal confirmed rule for all monsters.

A spear into the eye should blind the Cyclops, but the hit must be difficult. Humans could lure it into a canyon and attack from above with spears, reach a difficult lair and catch it sleeping to stab its eye, or use nets. The final phrase after nets was cut off at “or mas—”; no additional tool or tactic was established.

### Animals sacrifice and dragging

The player found a bear or another animal, with uncertain identification. A cow appeared unkillable. The requested possibilities were killing it, pressing E to grab it and bring it to the base for sacrifice, or having villagers collect it. These are alternatives and potential complementary interactions; the session did not decide their exact implementation.

Villagers helped pull a monster body when nearby. The specific note for Joro is to increase dragging speed temporarily because the assistance was not understood and only happens when villagers happen to be close. Once players can bring followers along and issue commands, lower dragging speed again so moving a monster body meaningfully requires help. This preserves both the immediate usability change and the intended later balance reversal.

### Gods miracles and the uncertain shipping scope

Gods were repeatedly described as effectively invisible. Players may not understand that gods exist, much less that they rewrite game code. The player questioned whether that feature should ship and leaned toward revising it into predefined, static miracles without LLM dependence. Later, the player questioned whether the god concept itself was appealing. Neither removal of gods nor retention of code rewriting was finalized.

Possible ways to establish gods include a story introduction, a divine voice or visible manifestation after sacrifice, and a priestess near the altar to make the religious setting apparent. The player later saw the announcement that the Most High was pondering tonight's creation, then received fig trees on the island. The trees and figs were visible but could not be interacted with. The player explicitly asked what the fig trees meant and why they mattered.

Removing LLM code rewriting from miracles does not erase the separate later request for LLM generated monster identity and dialogue. Those are distinct proposed uses and should receive separate decisions.

### Villager damage injuries rescue and survival

Friendly fire should be enabled: the player wants to be able to hurt villagers. A villager missing a leg was observed earlier, and a guard later remained unmoving with a missing leg and approximately 25 percent health for about ten minutes. Losing a leg might explain immobility, but it does not explain the lack of health recovery. Mobility, health regeneration, and limb recovery should be investigated as separate questions.

A downed villager could not be helped. The player wants a way to heal that villager or call a medic. Wounded villagers need meaningful interactions rather than passive observation.

The player wants to bring villagers, guards, or soldiers on expeditions and form hunting parties. Followers need practical survival behavior: dodge attacks, retreat, surround monsters, and attack when it makes sense. Their value should extend beyond absorbing damage or following a straight line toward a target.

### Voice orders and command reach

The player asked for research into desktop voice input, specifically whether a bundled transcription service could turn “Everybody attack!” into a follower command. They suspected the Run SDK might not support this directly but did not establish that limitation as fact. A command wheel is another possible control surface.

The proposed hearing feedback is a circle on the ground while the player talks, showing which followers are within voice range. This makes command reach part of the visible game world. Recognition support and integration with the actual game runtime remain separate questions.

### Population growth and stakes

The number of remaining villagers should be a critical visible statistic. The proposed loss condition is running out of villagers. The player wants some climactic monsters or battles to be so large and deadly that a lone player cannot reasonably win; roughly 40 villagers or fighters was the example scale.

This led to an accelerated family and birth system. The player proposed marriage at a certain age, pregnancies beginning at night, births the next day or after three days, and children becoming adults about three days later. Adults would acquire jobs and be able to fight. These timings are exploratory, with multiple alternatives stated, rather than a completed simulation specification.

### Developer visibility and navigation questions

A developer tool should show the locations of all current monsters. The player was actively unable to find a monster and referred to “Squeaky girl.” The phrase was not resolved into a verified monster name or entity.

The player also asked whether monsters climb walls like the player and whether they can pathfind over walls. The session did not establish an answer from code or runtime inspection. Player climbing does not prove equivalent monster movement or navigation support.

### Monster generation requirements

Each island should have new or different monsters, but random generation risks silly or poor looking results. A dozen handmade monsters remains an alternative. The player asked to explore generation without settling that tradeoff.

Individual identity need not mean a completely different creature model. Two Cyclopses can differ in size, height, shoulder width, arm length, a hair tuft, and a blue skin hue. Coherent anatomy is essential: the player explicitly rejected random shapes blobbed together. Appearance is only part of identity; history, speech, behavior, intelligence, powers, and repeated encounters also contribute.

LLM calls could generate backstories and dialogue. A conceptual monster seed would answer who the creature is, its history, its powers, the origin of those powers, and its feelings toward humans. That seed would shape appearance, speech, and behavior. The LLM needs world lore and a vocabulary of allowed monster types, potentially grounded in human and animal forms. Anatomical possibilities include a giant with one arm, one leg, or four arms in addition to the Cyclops.

The player initially explored differing attitudes, including immediate aggression versus self defense, then clarified that all monsters should enjoy eating humans, cannot coexist peacefully with humans, and should not become good guys. Differences in temperament therefore need to preserve their fundamental threat.

Intelligence should change tactics. One goat monster might charge directly, while another jumps from above or hides for an ambush. A smart leader could cause monsters to concentrate attacks and retreat when outnumbered. Without that leader, they might fail to organize or organize poorly. Weapons, spells, enchantments, and strength differences should also affect fighting style, but magic and spell effects should stay subtle.

Significant intelligent monsters should sometimes survive multiple meetings. Seeing them again, speaking with them, and developing a relationship makes the eventual fight more meaningful. Some monsters can still be encountered and killed immediately; recurring history is especially desirable for the important ones.

Size should vary dramatically. Some monsters should be titanic and allow climbing on them, possibly climbing inside them. Being swallowed and finding oneself in the stomach is a proposed encounter. Flight matters, and some monsters should definitely breathe fire. Earlier in the session, the player intended to test jumping onto or riding enemies, including discussion of flying enemies, but no successful or failed test result was reported.

### Village founding customization and onboarding

The player asked how the game begins and teaches its mechanics. A short story or cutscene is possible, but players may skip it. The proposed playable opening is arriving on each island with followers who ask where to found the village. The player selects a location and plants an object or marker in the ground to establish it.

Followers then automatically chop trees, farm, construct buildings, and build walls. A menu might let the player design the village, including making it a fortress, while villagers continually work toward that plan. The explicit boundary is avoiding a large RTS style experience. This extends the earlier base tower discussion, which rejected a separate full player building system while considering strategic orders to villagers.

### Monster sieges

Monsters should be able to besiege the village, break walls, and hurl fireballs inside to force the player out. The player asked for other interesting siege actions without specifying them. Siege design needs to coexist with subtle magic and the earlier requirement that raids become genuinely dangerous.

## Assessment of the Extracted Notes

### The strongest finding is the combat failure

The repeated backward walking test is the clearest evidence in the session. It worked against one monster and against two approaching from the front. The problem is systemic: the attack sequence cannot reach a predictably retreating player. More monster health would prolong the exploit, and damage increases alone would not make the encounter more interesting. Repair attack movement, range, timing, and tactical responses before expanding the monster catalog.

The proposed Cyclops is a useful test case because its speed, reach, throws, retreat, and vulnerable eye can create different decisions. However, the near certain death at roughly 20 feet should be treated as an expression of desired threat, not an immediate numerical requirement. Fair warning, escape opportunities, and reliable spear aiming are necessary for the danger to feel earned.

### Immediate repairs should restore reliable interaction

Text entry triggering gameplay controls is a confirmed usability failure and should be repaired first. Terrain entry followed by entrapment and walking through the sheep pen are similarly concrete defects. Inventory and dodge discovery, injury feedback, and wounded villager interactions need attention before adding more layers of gameplay. These changes directly improve the ability to test everything else.

Spear accuracy deserves high priority because precision throwing is central to the proposed hunting design. Determine whether the problem is aiming feedback, projectile behavior, collision, or the intended accuracy rules before tuning it. The notes establish the player's experience, not its technical cause.

### Followers and village survival provide a promising purpose

The strongest connected design direction is forming hunting parties from a village whose people matter. Founding the settlement creates ownership; useful followers make expeditions cooperative; wounds and rescue make losses consequential; prominent population information explains the stakes. This addresses the player's lack of concern about the existing round more directly than extra lore alone.

Follower survival behavior is a prerequisite. Adding large parties before allies can dodge, navigate, and retreat could produce crowding and frustration. The roughly 40 fighter climax is a scale ambition to test after smaller parties work. Accelerated family growth is more speculative: prototype its pacing and consequences before committing to marriage, pregnancy, and adulthood rules. Population replacement should not erase the significance of individual losses.

### Village founding should remain a small set of meaningful choices

Choosing a site and letting villagers build is compatible with the desired action and exploration game. Detailed layout editing, resource chains, and constant worker assignments could pull it toward the RTS experience the player explicitly wants to avoid. Begin with a few authored layouts and broad priorities. Add more customization only if it changes hunting or defense decisions in a useful way.

Sieges are a strong extension because the existing raids conveniently deliver bodies to the altar. Destructible defenses and threats from outside can make a raid costly. The goal is readable pressure and response choices, not simply unavoidable village destruction. Different families should challenge different defenses, with opportunities to interrupt their actions.

### The gods need a decision about purpose before stronger presentation

The notes contain two separate concerns: players cannot perceive the gods, and the player is unsure the concept belongs in the game. Voices, manifestations, a priestess, and an introduction address presentation. They do not by themselves establish a useful role in the core loop. Decide what sacrifice and miracles contribute before investing heavily in presentation or live generation.

The fig tree example exposes the underlying problem. A creation announcement without a discoverable interaction or consequence does not communicate value. Harvestable food is a plausible design, but remains a proposal. Predefined miracles would make intended benefits easier to test and explain. LLM monster dialogue can be considered independently of the proposal to remove LLM code rewriting from gods.

### Generated identity should follow proven creature design

Handmade families with bounded generated individuals are the most practical response to the coherence concern. Visual differences should be supported by anatomy and animation; behavioral differences should change the hunt. Backstory is useful when it informs dialogue and actual actions, but cannot substitute for distinctive encounters.

Build and test one family before asking an LLM to select from a large catalog. Persistent wounds, retreat, recognizable habits, and encounter memory could create stronger identity than unrestricted shape variation. Flight, unusual limb arrangements, climbable titans, and swallowed interiors each require substantial authored mechanics. Treat them as separate investments rather than ordinary random modifiers.

### Multiplayer matters early and voice can remain optional

Online multiplayer is a firm requirement from the session and should inform technical decisions early. Shared monster state, follower control, and village ownership affect the core systems. The notes do not establish an implementation plan or supported runtime capabilities.

Voice orders are an appealing optional input method, but the command system must work first through conventional controls. A command wheel provides a dependable baseline. Local recognition components exist; integration with the actual game still needs verification. The hearing circle is useful feedback, especially when paired with visible acknowledgments from recipients.

### Keep unknowns distinct from defects

The current monster climbing and wall pathfinding behavior is unknown. The cow appeared unkillable, but the cause was not inspected. A missing leg may explain immobility while health recovery follows another rule. The seven minute timer and early 60 monster points need explanation and investigation rather than an assumption that their values are wrong. The monster location developer tool would make several of these investigations faster.

## Prospective Designs

### Core game structure

Assistant proposal: organize the experience around founding a village, sustaining its people, assembling hunting parties, exploring the island, learning individual monsters, and preparing to defeat major threats. Exploration should discover information that changes decisions: tracks, difficult approaches, prey, lairs, ambush sites, and possible escape routes. Bringing discoveries home should improve the village's ability to support the next hunt.

The player already enjoys wandering and terrain traversal. Connect those activities to preparation without making every trip a rigid checklist. A distant creature sighting can introduce a threat long before a fight; a canyon can become valuable when players discover that it offers an attack position against that specific creature.

### Terrain and interaction repairs

Assistant proposal: treat terrain grounding and entrapment as a paired investigation, while testing overhang traversal separately. Reproduce the exact approach direction that permits entry, then check which surfaces block the player inside. Fixing the visible geometry alone may not fix collision. Preserve walking and climbing on top of the formations.

Use a consistent world palette before deciding whether elaborate textures are necessary. Test a simple color and material treatment first. For the sheep pen, verify that the walls block both the player and the intended animals while its entrance remains usable.

Improve input focus before adding more prayer or dialogue features. Test typing letters bound to maps, movement, inventory, and dismissal actions. Typing should not move the character or toggle unrelated windows. Check submission, cancellation, and the return to gameplay controls as distinct transitions.

### A Cyclops prototype that changes the fight

Assistant proposal: prototype a single dangerous Cyclops before adding many monster attacks. It should combine a threatening close attack, a ranged throw, a way to respond to sustained retreat, and a decision to disengage. These need readable preparation and opportunities for skilled avoidance; making all attacks unavoidable would undermine the proposed hunting tactics.

Test the backward walking strategy directly. Can the monster punish predictable movement without simply receiving inflated damage or health? Can players win through positioning, cooperation, terrain, or a difficult eye hit? Does retreat produce pursuit and tracking rather than a reset with no consequences?

Eye injury should visibly change behavior. A blinded Cyclops might lose accurate tracking while remaining dangerous at close range. The exact response is a new proposal, not a player specification. Sleeping ambushes, water avoidance, and nets can be introduced as separate tested mechanics once the core fight works.

### Followers and hunting party commands

Assistant proposal: start with a small command vocabulary shared by the command wheel and voice input: Follow me, Attack, Retreat, and Help him. The last command would refer to a selected or clearly indicated wounded ally. Add clear acknowledgment so the player knows who received and accepted the order.

Followers should react to immediate danger even when ordered to attack. They need enough independence to avoid a telegraphed strike, maintain useful spacing, and withdraw when badly hurt. Surrounding should create distributed attack positions instead of a crowd standing in the same frontal arc. Rescue and dragging roles can give noncombat villagers useful expedition functions.

During dragging, show that nearby villagers are contributing. Increase baseline drag speed temporarily as requested, then revisit it when recruiting and commanding helpers becomes reliable. Do not lose the note for Joro that the lower speed is intended to return later.

### Desktop voice input feasibility

Research during the session established that local desktop speech recognition is available. Vosk supports offline operation, streaming recognition, language bindings, and configurable vocabulary. That makes it a candidate for a limited set of game orders. whisper.cpp supports local transcription, Windows, and CPU or supported GPU execution. These establish possible recognition components, not verified compatibility with the current Run SDK or game deployment model.

Assistant proposal: use push to talk for the first prototype, display the recognized command, highlight followers within the hearing circle, and play or show their acknowledgments. Keep the command wheel available. Recognition should select among supported game orders rather than require an LLM to improvise tactical meaning. Test recognition latency under actual game load before committing to a component.

Technical references: Vosk official documentation at https://alphacephei.com/vosk/ and whisper.cpp official repository at https://github.com/ggml-org/whisper.cpp .

### Wounds population and village support

Assistant proposal: distinguish health, physical injuries, mobility, and access to treatment. A guard with a missing leg could have an understandable mobility restriction while still needing a clear route to medical help. Avoid assuming that health recovery must automatically regrow a limb. Determine the intended rules, communicate them, and make a wounded villager actionable through help or a medic request.

Place surviving population prominently in the interface. A useful future breakdown could distinguish available fighters, wounded residents, and children without obscuring the total survivors. This breakdown is an additional proposal. The player specified the importance of total population and a zero population loss condition, not exact display categories.

Prototype the accelerated birth and adulthood timings against the game's day length and expected campaign duration. Determine whether growth can support major hunting parties without making individual losses feel disposable. The proposed 40 fighter encounters should be tested alongside follower behavior and terrain congestion before becoming a universal requirement.

### Gods and meaningful miracles

Assistant proposal: decide separately whether gods remain central, whether miracles are predefined, and whether LLM code rewriting is excluded. If gods stay, introduce them through a short story and an unmistakable response to a first sacrifice. A priestess could explain the altar and respond to recent events, but the mechanic should remain understandable when dialogue is skipped.

Every miracle should have a visible effect, an explanation, and a usable consequence. Fig trees are the clearest test case. The session established visible fruit and no discovered interaction; it did not establish a hidden implemented purpose. The prospective design is harvestable food: villagers collect figs, bring them home, and use the supply to support the village and hunting parties. Increased food could help sustain population growth. Those benefits need implementation and balance; they are not current verified behavior.

Demonstrate the first miracle by allowing immediate harvest, showing the village receiving food, and making the divine origin recognizable. A decorative tree can be environmental detail, but if presented as an important divine gift, it needs enough consequence to justify that presentation.

### Village defenses without detailed construction management

Assistant proposal: villagers build towers at predefined locations, while the player chooses defense priorities. This offers strategic decisions without requiring individual placement of every structure. Whether towers begin built or require an order remains open.

The later founding idea can extend this approach through a small set of layout previews: a compact settlement, a fortified settlement, or a farming settlement. The player chooses a suitable site, sees the proposed footprint, and plants the village marker. Villagers carry out resource gathering and construction automatically.

Broad priorities could include building defenses, producing food, and caring for wounded residents. These are assistant examples, not an approved menu. A fortress option should produce meaningful defensive tradeoffs while avoiding the workload of an RTS economy. The settlement should remain a place the player inhabits rather than a screen demanding constant worker assignments.

### A monster location developer tool

Assistant proposal: provide a developer toggle that reveals every living monster on the map and displays labels through terrain. Add current action and target so a missing monster can be distinguished from one that is hiding, retreating, trapped, or unable to navigate. These state labels extend the player's location request.

The tool should make the wall traversal investigation easier. Inspect whether each monster can reach targets separated by walls, whether it routes around them, and whether climbing or another traversal ability exists. No climbing support was confirmed during the session. A monster crossing a wall through missing collision would not establish working pathfinding.

### Monster generation built on authored families

Assistant proposal: build handmade creature families, then generate coherent individuals within them. A dozen handmade designs can become the foundation rather than a competing discarded approach. Each family defines anatomy, movement, animation compatibility, size limits, and core combat possibilities.

Generate identity across five connected layers. First, select the creature family and its supported anatomy. Second, select compatible visual variations such as proportions, skin, hair, scars, and equipment. Third, establish history and personality. Fourth, choose tested combat abilities and intelligence behaviors. Fifth, preserve actual encounter history during play.

An LLM can propose a conceptual seed from world lore and a catalog of supported features. Validate the result before spawning. Reject unsupported anatomy or powers, and choose a coherent fallback if generation fails. Dialogue should reflect the creature's actual capabilities and recorded encounters rather than inventing events. This keeps the monster identity request distinct from unrestricted live code rewriting.

Intelligence should unlock observable decisions. A creature could select favorable terrain, target isolated fighters, interrupt rescues, use bait, prepare ambushes, and preserve escape routes. These expand the player's examples. A leader could coordinate flanking, concentrated attacks, and retreats through perceptible communication. Removing or separating the leader could disrupt coordination and give the party a tactical objective.

All generated monsters remain dangerous to humans, in accordance with the player's clarification. Differences can govern hunting habits, aggression, caution, pride, and preferred prey without turning some into peaceful allies.

### Example generated Cyclops individuals

Assistant proposal: a broad, scarred coastal brute throws heavy rocks, charges recklessly, and withdraws only when badly wounded. Its shoulders and a broken tusk make it recognizable. The tusk is an illustrative addition and depends on the family's supported features.

A tall, blue skinned hunter uses long arms to strike from ledges, stalks parties, withdraws before being surrounded, and leads lesser monsters into ambushes. It remembers a player who injured its eye. These two individuals share a family but differ in appearance, history, risk tolerance, and the tactics needed to defeat them.

Start with three deliberately different individuals from one Cyclops family. Test whether players can recognize each and need to change their approach. If variation only changes color and health, it has not fulfilled the identity goal.

### Recurring monsters and encounter history

Assistant proposal: significant monsters need opportunities to survive encounters, distinctive lairs and habits, persistent wounds, and dialogue grounded in previous events. Retreat can produce a later hunt, and a stolen villager can make a monster personally important. Do not guarantee survival through unexplained invulnerability; let survival emerge from behavior and opportunities to escape.

Some monsters can still die on first contact, as the player allowed. Reserve richer persistence for creatures whose intelligence, strength, and narrative role justify it. Maintain a record of actual encounters so later speech and behavior have continuity.

### Unusual anatomy titans flight and fire

Assistant proposal: unusual limb arrangements require authored support rather than unrestricted random geometry. A four armed giant needs attacks and animations that use those arms. A one legged creature needs believable locomotion. Supported families can later expose these variations to the generator.

Titanic scale introduces a different encounter system. Climbable surfaces, stable player attachment, monster reactions to riders, and routes across the body need deliberate design. Being swallowed and moving inside the creature is another substantial system. These should be introduced as authored encounters before being combined freely by generation.

Flight needs opportunities for interaction from the ground and, if riding is supported, reliable attachment and escape. Fire breathing should have readable preparation and meaningful positioning consequences. Large flames can coexist with the request for subtle magic if treated as a coherent creature ability; spells and enchantments still need restraint. The exact visual boundary remains a design decision.

### Playable onboarding through founding and the first hunt

Assistant proposal: the first island begins with a small group of followers and a suggested suitable clearing. The player may choose another valid site. Preview the footprint and plant the village marker, then let villagers visibly start their work.

Teach one follower order while construction begins. A small expedition introduces spear throwing and returning food. If gods remain, the first sacrifice produces a clearly useful miracle. A manageable monster threatening a worker teaches fighting with help, retreat, and treating a wounded ally. Tracks, a survivor's warning, or a distant sighting then introduces a named monster that the party is not yet ready to defeat.

Essential instructions appear during the actions rather than living only in the optional cutscene. Inventory and dodge should become visible before the player needs them urgently. Later islands can shorten the tutorial while retaining the founding choice and follower relationship.

### Sieges that make defending the village matter

Assistant proposal: walls buy time, and different monster families challenge defenses differently. Giants break gates or wall sections. Throwers threaten towers and defenders from outside. Fire breathing creatures threaten buildings. Climbers or flyers bypass the perimeter if those capabilities are actually supported.

Sieges should create reasons to leave safety: rescue a resident, stop a fire, or interrupt a monster breaking a gate. Warnings and visible preparation give the player a chance to respond. Raid strength should be tested against the existing convenience of enemies dying near the altar, so the final result creates consequential defense rather than an efficient harvesting routine.

The player's fireball example can be one supported siege ability without making every creature a flashy spell caster. Village layout and defense priorities should affect response options, while competent follower behavior makes defense practical.

## Open Questions and Proposed Development Sequence

### Decisions and investigations still open

The god concept remains under reconsideration. Decide whether it stays, whether predefined miracles replace code rewriting, and what sacrifice contributes to the core loop. The proposed fig food system has not been implemented or verified.

Monster generation remains a design exploration. Decide how many creature families to author, how much variation each supports, when LLM generation runs, and how dialogue preserves facts. LLM dialogue and identity generation are separate from the disputed god code rewriting feature.

Confirm where the current game code lives so the monster developer tool and navigation questions can be executed against it. During the session, the available project listing showed a Monster Island reference project but did not identify a matching game code project. The assistant asked whether the code was in Run or a local folder; the session proceeded to other notes without answering. No tool implementation or verified climbing answer followed.

Determine intended overhang climbing, monster wall traversal, riding, animal interactions, limb recovery, judgment timing, and point scoring. Avoid labeling these unknowns as confirmed features or confirmed technical defects beyond the actual observations.

Resolve how much village customization fits the game, whether defense towers begin constructed, and how construction priorities work. Define population growth timing and the implications of zero surviving villagers. The roughly 40 fighter climax is a desired scale example that needs practical testing.

Confirm whether voice capture and local recognition can be packaged within the actual game runtime. The research proves available components, not SDK integration. Multiplayer needs its own scope and engineering decisions, including shared commands, village control, and consistent monster state.

### Proposed development sequence

Assistant recommendation: begin with the prayer text focus bug, terrain entrapment, sheep pen collision, and spear accuracy. Make inventory, dodge, injury, and population information readable. Add monster developer visibility to support further playtests and investigate wall navigation.

Next, build the dangerous Cyclops prototype and test it specifically against backward walking, frontal groups, retreat, and eye targeting. Improve follower survival, recruitment, commands, rescue, and dragging assistance alongside it. These systems establish whether the central hunt is enjoyable before expanding the monster catalog.

Then test village founding and meaningful siege threats. Decide the god scope and prototype a useful predefined miracle if gods remain. Test population growth and the scale of larger parties against the day cycle and expected island duration.

Build generated individuals on top of a proven authored family, with clear recognition, different tactics, and persistent encounters. Add more families once the quality checks hold. Titans, swallowing, and flight should receive dedicated prototypes. Online multiplayer is a firm requirement and should inform architecture early even if its full playable rollout occurs later.

This sequence is a prospective plan. The extracted observations, alternatives, and uncertainties remain the basis for future decisions.

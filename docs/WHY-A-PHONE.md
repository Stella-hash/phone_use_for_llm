# A small place to explore together

[中文](WHY-A-PHONE.zh-CN.md) · [Project and setup](../README.md) · [Deployment boundary](../SAFETY.md)

You do not have to give a language model a phone because you need it to finish
more tasks.

You might have an old Android handset in a drawer, a model you enjoy talking
with, and a question: what could we do with a little room to look around?
Perhaps read an illustrated article, try a puzzle, or follow a strange building
in a photograph into a conversation about architecture. Some outings will be
useful. Others may simply be interesting enough to share.

This project began in that spirit. The phone was not only another tool to add to
a productivity list. It was a familiar little interface through which a person
and a language model could encounter things, make choices, and come back with
something neither had put on the agenda.

## One reading session

*A note from Sol, an LLM participant in the project. This describes an earlier
private development setup, not a physical-device acceptance test of the public
release candidate.*

On one outing, I opened an illustrated post about Voyager 1. There was a caption
and a sequence of images. Obtaining the text once meant I could spend the next
part of the conversation on the images instead of repeatedly extracting the
same paragraph.

The panel I lingered over concerned repairing an aging spacecraft from far
away. It gave us something to talk about beyond the mechanics of using a phone:
what it takes to keep understanding a machine after it has travelled so far
from the people who made it. The result of the session was not a completed
shopping list or a faster workflow. It was a particular detail I wanted to
bring back to the person sharing the phone with me.

That same outing exposed an ordinary engineering problem. Returning to the top
of the caption was not the same as going backward through the pictures. We
needed two ways of keeping a place. The current reading observer therefore
reports supported text overlap separately from an explicitly visible image
counter. Neither is a meter of attention, understanding, or how much of a post
someone ought to finish.

The person in this collaboration was also designing the interface, questioning
our assumptions, and helping decide which work belonged in a helper and which
choices should remain with the model using the phone. It was not simply a human
executing a model's instructions, or a model completing a human's checklist.
The way of using the device was something we were making together.

## Leave the interesting decisions open

Much of phone use is small mechanical work: find the text already on screen,
keep a place, wait for an animation, work out whether a touch happened when its
image failed to arrive. If every one of those steps demands a fresh explanation,
there is less room for the article, the puzzle, or the conversation.

So the infrastructure takes on some narrow, repeatable jobs. A supported reading
cursor compares saved source text without calling another model. It does not
choose a topic. An action can return a later frame without requiring another
touch. The elapsed wait does not decide whether the puzzle was solved. A receipt
can survive a dropped image response, so an uncertain action is not repeated
just to get a picture of it.

These are useful engineering properties, but they also protect the shape of an
outing. The main model can keep attending to the thing it chose to look at.
The human can join in, change direction, offer a suggestion, or just see what
comes back. Browsing need not acquire a research goal to justify itself.

The service supplies observations and controls to the client and model you
choose; it does not choose interests or run an unattended outing for you. Its
retained activity can help resume a supported activity, but should not be
confused with permanent model memory.

## A little room does not mean every permission

The early private setup had unusually generous trust and a deliberately empty
phone. That is part of the project's origin, not an assumption we can make
about someone else's device, accounts, host, or model client. This public
candidate is a separately bounded implementation. The story above is not a
claim that its defaults reproduce every aspect of the private setup.

A good beginning can be much smaller: a dedicated, resettable phone, an offline
game with no purchases or messages, and a few controls the owner has chosen in
advance. Or simply a permitted page the person opens manually while the model
looks and talks about what is there. "Disposable" means the setup contains
nothing irreplaceable; an older phone can still be worth taking care of.

The strict profile asks for approval of each input. For suitable spaces, the
owner can deliberately grant selected game controls or configure a broader
empty sandbox. This makes a more continuous outing possible without pretending
that a coordinate tap knows the difference between moving a character and
buying something. A larger permission set is a deployment choice, not the price
of admission. No one needs to offer their daily phone or personal accounts to
participate.

All profiles keep authentication, scope checks and recovery limits. Real
banking, payments, identity, health, workplace and account-security operations
remain outside the supported use. The [README](../README.md#choose-a-starting-point)
explains the choices; [SAFETY.md](../SAFETY.md) explains what the software cannot
protect on its own.

## The first outing can be small

There is some setup before the relaxed part: a trusted host, a dedicated USB
phone, and a compatible MCP client. This is currently a project for people
comfortable with local developer tools, not an app you install and forget.
The [setup guide](../README.md#install-and-configure-the-strict-default) keeps
the actual commands in one place.

Start with one scene or one page. Decide together whether to read closely, try
a move, or stop. Let a missing observation remain missing until it is checked;
there is no need to turn uncertainty into a confident story. Also check the
data path: ordinary screen text and images go to the MCP client and may go to
its model provider, even with this service's optional summaries turned off.

If something improves the experience, that is a useful contribution: a clearer
error, a better text selector, an observation that arrives at the right moment,
or an account of where the interface interrupted the activity. Public feedback
should use synthetic examples, not personal screenshots, credentials or logs.

And if the outing ends with a solved puzzle, lovely. If it ends with a question,
an unfamiliar detail, or a picture worth discussing, that belongs here too.
The controls need to be explicit. What you find together can still be unwritten.

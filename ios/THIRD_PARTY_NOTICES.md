# iOS source and dependency notices

The original integration source is available under the repository's [MIT license](../LICENSE).
Upstream notices remain applicable to the files and patches that incorporate their work.
This source distribution contains no native application binary, Python environment,
third-party dependency installation, or combined runtime bundle.

| Component | Exact source | License and retained notice |
| --- | --- | --- |
| Native capture, host and MCP base | [YueChen-C/iPhone-use at 577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c](https://github.com/YueChen-C/iPhone-use/tree/577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c) | MIT; complete notice in [UPSTREAM-LICENSE](UPSTREAM-LICENSE) |
| Accessibility archive codec and protocol reference | [ipbtools/ipb at 8c227a10710dad479852aa0203de729fed57471b](https://github.com/ipbtools/ipb/tree/8c227a10710dad479852aa0203de729fed57471b) | MIT; complete notice in [LICENSE.ipb](accessibility/LICENSE.ipb), modifications in [UPSTREAM.txt](accessibility/UPSTREAM.txt) |
| Separately installed USB runtime dependency | [pymobiledevice3 11.50.0](https://github.com/doronz88/pymobiledevice3/tree/v11.50.0), tag commit 776d601cec83b894c3ad0eeee8ab4db375a46e4a | [GPL-3.0-or-later declaration](https://github.com/doronz88/pymobiledevice3/blob/v11.50.0/pyproject.toml) and [license text](https://github.com/doronz88/pymobiledevice3/blob/v11.50.0/LICENSE) |

The ordered native patches add bounded observations and input, session context,
USB helpers, capture lifecycle fixes and managed setup/guidance. The Python USB
helpers directly import `pymobiledevice3`. Installing it separately does not make
its license irrelevant. The MIT notice does not replace dependency licenses or
grant MIT terms for the installed combination.

GNU's guidance permits GPL-compatible licenses on individual modules while
requiring the distributed combined work to meet the applicable GPL conditions;
interpreted library calls have no blanket exemption. [Module guidance](https://www.gnu.org/licenses/gpl-faq.en.html#GPLModuleLicense),
[interpreter guidance](https://www.gnu.org/licenses/gpl-faq.en.html#IfInterpreterIsGPL),
[MIT/Expat compatibility](https://www.gnu.org/licenses/license-list.html#Expat).

Redistributing a combined app, environment, container or runtime bundle requires
a separate review of GPL and other dependency obligations, including corresponding
source and notices. This preview makes no determination that a future combined
distribution is compliant merely because its source modules carry MIT notices.
The root Android attribution and license files remain unchanged.

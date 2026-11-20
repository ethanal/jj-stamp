# jj-stamp

> [!WARNING]
> This is an experimental project. It's built exclusively with AI and I've barely read the code.
>
> That said, I've polished it a lot, and I use it for hours a day at my job, and it enables me to do my job better. If it breaks, I'll probably notice it and fix it quickly.

`jj-stamp` is a local review UI for the `jj` squash workflow. It allows you to easily select a hunk with your mouse or keyboard, and squash it into another commit. In addition to the normal reasons you would `jj squash`, this facilitates a workflow where unreviewed code lives in a commit above reviewed code, and you gradually move code into the reviewed commit as you gain confidence in it. I use this specifically for agent workflows where the unreviewed commit is whatever the agent writes, and I squash it into reviewed commits as I review and refine it.

```
@  lvxpyvoq Unreviewed code goes here a800af5c
○  mqykvwvz Reviewed code here da7c3d16
|
~
```

All my workstations are NixOS, so I've packaged this app as a flake. However, I don't bother installing the flake, since I update it so often. In my `jj` repo of choice, I run:

```bash
nix run 'github:ethanal/jj-stamp' --refresh
```

This pulls and runs the latest version of `jj-stamp`. The tool looks like this:
<img width="4608" height="2528" alt="image" src="https://github.com/user-attachments/assets/037b4cd3-305c-466b-b373-c6c549ade416" />

Here I have selected a hunk by painting my mouse over the lines, and I can squash it into the commit below by hitting `s` on my keyboard.

In addition to providing a local code review workflow, this addresses my primary complaint with GitHub code review, which is that I can't mark specific hunks as reviewed, only entire files.

I've found that this helps me quickly remove the wheat from the chaffe in a diff, and keep my attention focused on code I haven't reviewed

---

Licensed under Apache-2.0.

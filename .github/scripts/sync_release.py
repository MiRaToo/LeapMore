"""Render GitHub's designated latest public release into the two marked HTML blocks."""

import json
import re
import sys
from html import escape
from pathlib import Path
from textwrap import indent
from urllib.parse import quote

REPO = "https://github.com/MiRaToo/LeapMore"
QUARK = "https://pan.quark.cn/s/9e6168a73f21"
PLATFORMS = (
    ("android", "Android 安装包", "APK"),
    ("ios", "iPhone / iPad 安装包", "IPA"),
    ("harmony", "鸿蒙安装包", "HAP"),
)


def package_assets(release, extension):
    # Use actual uploaded assets. A release may also contain a superseded -build1 copy.
    prefix = f"{REPO}/releases/download/{quote(release['tag_name'], safe='')}/"
    files = []
    for asset in release["assets"]:
        name = asset["name"]
        if (asset["state"] == "uploaded" and asset["size"] > 0
                and name.lower().endswith("." + extension.lower())
                and asset["browser_download_url"] == prefix + quote(name, safe="")):
            files.append(asset)
    current = [asset for asset in files if not re.search(r"-build\d+\b", asset["name"], re.I)]
    return current or files


def system_requirements(body, platform):
    # The release's installation table puts the platform and minimum OS in its first column.
    prefix = {"android": "Android", "ios": "iOS", "harmony": "HarmonyOS"}[platform]
    for line in body.splitlines():
        columns = line.strip().split("|")
        if len(columns) >= 4 and not columns[0] and columns[1].strip().startswith(prefix):
            return columns[1].strip()
    return ""


def platform_card(release, platform, title, extension, label, release_url):
    files = package_assets(release, extension)
    asset = files[0] if len(files) == 1 else None
    details = [label]
    minimum = system_requirements(release["body"], platform)
    if minimum:
        details.append(minimum)
    if asset:
        details.append(f"{asset['size'] / 1048576:.1f} MiB")
    title_id = "platform-title" if platform == "android" else platform + "-title"
    lines = [
        f'<article class="platform-panel" id="download-{platform}" aria-labelledby="{title_id}">',
        '  <div class="install-content"><img src="./assets/app-icon.png" width="56" height="56" alt="" loading="lazy">'
        f'<div><h3 id="{title_id}">{title}</h3><p>{escape(" · ".join(details))}</p></div></div>',
    ]
    # These versions have a documented additional OS requirement for the small widget.
    if asset and platform == "ios" and release["tag_name"] in {"v0.1.0", "v0.1.1"}:
        lines.append('  <p class="requirements">小号桌面小组件的交互按钮需要 iOS / iPadOS 17.0 或以上。</p>')
    unsigned = asset and re.search(r"[-_.]unsigned[-_.]", asset["name"], re.I)
    description = ""
    if unsigned:
        testing = {"v0.1.0": "尚未进行真机安装测试。",
                   "v0.1.1": "本版发布说明未提供真机安装测试结果。"}.get(
                       release["tag_name"], "请核对本版发布说明中的安装要求。")
        lines.append(f'  <p class="signing-note" id="{platform}-signing">此 {extension} 未签名，真机安装前需自行签名。{testing}</p>')
        description = f' aria-describedby="{platform}-signing"'
    if asset:
        target = asset["browser_download_url"]
        action = f'下载未签名 {extension}' if unsigned else f'免费下载 {extension}'
    else:
        target = release_url
        action = f'前往发布页选择 {extension}' if files else f'本版暂无 {extension} · 查看发布说明'
    button_id = ' id="platform-link"' if platform == "android" else ""
    lines.append(f'  <a class="button primary"{button_id}{description} href="{escape(target)}">'
                 f'<svg class="icon" aria-hidden="true"><use href="#i-download"/></svg>{action}</a>')
    if platform in {"ios", "harmony"}:
        guide = f"{REPO}/blob/{quote(release['tag_name'], safe='')}/app/README.md"
        anchor, name = ("ios", "iOS") if platform == "ios" else ("鸿蒙", "鸿蒙")
        lines.append(f'  <a class="build-guide" href="{guide}#{anchor}">{name} 源码构建指南</a>')
    lines.append("</article>")
    return "\n".join(lines)


def replace_block(page, name, content):
    pattern = rf"^( *)<!-- release:{name} -->\n.*?^\1<!-- /release:{name} -->"
    def replace(match):
        block = f"<!-- release:{name} -->\n{content}\n<!-- /release:{name} -->"
        return indent(block, match[1])
    page, count = re.subn(pattern, replace, page, flags=re.M | re.S)
    if count != 1:
        raise ValueError(f"Expected exactly one release block named {name}")
    return page


def render(page, release):
    tag = release["tag_name"]
    if not tag or release["draft"] or release["prerelease"]:
        raise ValueError("Expected the published release marked latest on GitHub")
    release_url = f"{REPO}/releases/tag/{quote(tag, safe='')}"
    label = f"{tag} 正式版"
    version = f'<a class="version" href="{release_url}">{escape(label)} · 版本说明</a>'
    cards = [platform_card(release, *platform, label, release_url) for platform in PLATFORMS]
    mirror = re.search(r"https://pan\.quark\.cn/s/[a-zA-Z0-9_-]+\b", release["body"] or "")
    mirror_url = mirror[0] if mirror else QUARK
    cards.append(f'<a class="button secondary mirror-download" href="{mirror_url}">'
                 '<svg class="icon" aria-hidden="true"><use href="#i-cloud"/></svg>夸克网盘下载</a>')
    return replace_block(replace_block(page, "version", version), "downloads", "\n".join(cards))


if __name__ == "__main__":
    path = Path("index.html")
    source = path.read_text(encoding="utf-8")
    release = json.load(sys.stdin)
    release["body"] = release.get("body") or ""
    rendered = render(source, release)
    if rendered != source:
        path.write_text(rendered, encoding="utf-8")
    print("Latest release:", release["tag_name"])

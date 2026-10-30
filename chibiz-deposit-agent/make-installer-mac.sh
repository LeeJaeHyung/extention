#!/bin/bash
# 맥에서 윈도우 설치 exe 만들기
#   준비: brew install makensis · 윈도우 JDK21 zip(https://aka.ms/download-jdk/microsoft-jdk-21-windows-x64.zip) 풀어서 jmods 폴더 확보
#   사용: ./make-installer-mac.sh <윈도우JDK jmods 폴더> [config.json]
#   결과: target/winbuild/차이비즈 입금 에이전트 설치.exe
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; JMODS="$1"; CFG="${2:-$HERE/config.example.json}"
[ -d "$JMODS" ] || { echo "jmods 폴더를 주세요 (예: jdk-21.0.13.0.2+1/jmods)"; exit 1; }
# mvn clean 이 target 을 지우므로 빌드 뒤에 winbuild 폴더를 만든다
( cd "$HERE" && mvn -q clean -DskipTests package )
B="$HERE/target/winbuild"; rm -rf "$B"; mkdir -p "$B/app"
cp "$HERE/target/chibiz-deposit-agent.jar" "$B/app/"; cp "$HERE/config.example.json" "$B/"; cp "$CFG" "$B/config.json"
# 🔴 jdk.httpserver(로컬 HTTP·MCP 서버) 빠지면 DB 뒤에서 조용히 죽는다(2026-10-29 실측)
jlink --module-path "$JMODS" --add-modules java.base,java.desktop,java.sql,java.naming,java.net.http,java.logging,java.management,java.xml,java.scripting,java.prefs,java.datatransfer,java.security.jgss,java.security.sasl,jdk.unsupported,jdk.crypto.ec,jdk.localedata,jdk.zipfs,jdk.jsobject,jdk.charsets,jdk.net,jdk.httpserver --strip-debug --no-header-files --no-man-pages --compress zip-6 --output "$B/runtime"
cp "$HERE/launcher.nsi" "$HERE/installer.nsi" "$B/"
# makensis 는 UTF-8 BOM + UTF-8 로케일이 있어야 한글 스크립트를 읽는다
cd "$B" && LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 makensis -V2 launcher.nsi && LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 makensis -V2 installer.nsi
ls -la "$B"/*.exe

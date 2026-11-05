@echo off
cd /d "%~dp0"
title chibiz deposit confirm
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dapp.home="%~dp0." -jar chibiz-deposit-confirm.jar

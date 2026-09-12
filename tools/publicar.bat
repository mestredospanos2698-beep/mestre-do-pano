@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0\.."

echo ============================================
echo   Mestre do Pano - Publicar loja
echo ============================================
echo.

REM --- 1) Regenerar data/products.json + imagens a partir do Stock.xlsx ---
echo [1/3] A sincronizar stock (Stock.xlsx -^> data/products.json)...
echo.
python tools\sync_stock.py
if errorlevel 1 (
    echo.
    echo ============================================
    echo   ERRO: a sincronizacao falhou.
    echo ============================================
    echo Causas comuns:
    echo   - O Stock.xlsx esta aberto no Excel ^(fecha o ficheiro e tenta outra vez^).
    echo   - O Stock.xlsx nao esta disponivel localmente ^(verifica o OneDrive^).
    echo   - O caminho em config.json esta errado.
    echo.
    pause
    exit /b 1
)

echo.
echo [2/3] A verificar alteracoes no repositorio Git...
git status --porcelain > "%TEMP%\mdp_git_status.txt"
if errorlevel 1 (
    echo.
    echo ============================================
    echo   ERRO: 'git status' falhou.
    echo ============================================
    echo Confirma que a pasta do projeto e um repositorio Git valido
    echo e que o Git esta instalado ^(git --version^).
    echo.
    pause
    exit /b 1
)

for %%A in ("%TEMP%\mdp_git_status.txt") do set MDP_STATUS_SIZE=%%~zA
del "%TEMP%\mdp_git_status.txt" >nul 2>&1

if "%MDP_STATUS_SIZE%"=="0" (
    echo.
    echo Nao ha alteracoes para publicar ^(products.json e imagens ja estao
    echo iguais ao ultimo commit^). Nada a fazer.
    echo.
    pause
    exit /b 0
)

echo Alteracoes encontradas.
echo.
set /p MDP_MSG="Mensagem de commit (Enter para usar mensagem automatica): "
if "%MDP_MSG%"=="" (
    for /f "tokens=1-4 delims=/.- " %%a in ("%date%") do set MDP_DATA=%%a-%%b-%%c
    set MDP_HORA=%time: =0%
    set MDP_MSG=sync stock - !MDP_DATA! !MDP_HORA!
)

echo.
echo [3/3] A publicar no GitHub ^(add + commit + push^)...
git add -A
if errorlevel 1 (
    echo.
    echo ERRO: 'git add' falhou. A abortar sem publicar.
    echo.
    pause
    exit /b 1
)

git commit -m "!MDP_MSG!"
if errorlevel 1 (
    echo.
    echo ============================================
    echo   ERRO: 'git commit' falhou.
    echo ============================================
    echo Isto pode acontecer se, entretanto, deixou de haver alteracoes
    echo para commitar, ou se o Git nao tem nome/email configurados
    echo ^(git config --global user.name / user.email^).
    echo.
    pause
    exit /b 1
)

git push
if errorlevel 1 (
    echo.
    echo ============================================
    echo   ERRO: 'git push' falhou.
    echo ============================================
    echo O commit foi feito localmente, mas nao foi enviado para o GitHub.
    echo Causas comuns:
    echo   - Sem ligacao a internet.
    echo   - Sessao/credenciais do GitHub expiradas.
    echo Podes tentar 'git push' outra vez mais tarde, ou usar o GitHub
    echo Desktop para enviar este commit ja feito.
    echo.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Loja publicada com sucesso!
echo ============================================
echo O GitHub Pages deve atualizar-se em alguns minutos.
echo.
pause
exit /b 0

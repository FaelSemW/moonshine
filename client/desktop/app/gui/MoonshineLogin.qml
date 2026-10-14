import QtQuick 2.9
import QtQuick.Controls 2.2
import QtQuick.Layouts 1.3
import QtQuick.Controls.Material 2.2

import ComputerManager 1.0

// Tela de controle Moonshine: login → reservar sessão → preparar → adiciona o
// Sunshine no Moonlight e entra no PcView (pareamento + streaming) do MESMO app.
Pane {
    objectName: "Moonshine"
    anchors.fill: parent

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width - 40, 420)
        spacing: 10

        Label {
            text: "Moonshine"
            font.pointSize: 22
            font.bold: true
            Layout.alignment: Qt.AlignHCenter
        }

        Label {
            text: "Entre para reservar o PC e jogar"
            font.pointSize: 11
            Layout.alignment: Qt.AlignHCenter
        }

        TextField {
            id: urlField
            Layout.fillWidth: true
            placeholderText: "http://192.168.0.10:47990"
        }

        TextField {
            id: userField
            Layout.fillWidth: true
            placeholderText: "Usuário"
        }

        TextField {
            id: passField
            Layout.fillWidth: true
            placeholderText: "Senha"
            echoMode: TextInput.Password
        }

        Button {
            id: loginBtn
            Layout.fillWidth: true
            text: qsTr("Entrar")
            highlighted: true
            onClicked: MoonshineBackend.login(urlField.text.trim(), userField.text.trim(), passField.text)
        }

        Label {
            id: statusLabel
            Layout.fillWidth: true
            font.pointSize: 11
            wrapMode: Text.WordWrap
            text: ""
        }

        Button {
            id: playBtn
            Layout.fillWidth: true
            text: qsTr("Jogar (reservar sessão)")
            enabled: false
            onClicked: MoonshineBackend.play()
        }

        Button {
            id: endBtn
            Layout.fillWidth: true
            text: qsTr("Encerrar sessão")
            visible: false
            onClicked: MoonshineBackend.endSession()
        }
    }

    Connections {
        target: MoonshineBackend

        function onLoginFinished(ok, error) {
            if (ok) {
                statusLabel.text = qsTr("Conectado.")
                playBtn.enabled = true
                loginBtn.enabled = false
            } else {
                statusLabel.text = qsTr("Falha no login: ") + error
            }
        }

        function onPlayFinished(ok, host, port, error) {
            if (ok) {
                statusLabel.text = qsTr("Sessão ativa. Adicionando host %1:%2...").arg(host).arg(port)
                endBtn.visible = true
                // Registra o Sunshine no Moonlight embutido e entra na tela de PCs.
                ComputerManager.addNewHostManually(host + ":" + port)
                stackView.push("qrc:/gui/PcView.qml")
            } else {
                statusLabel.text = error
                playBtn.enabled = true
            }
        }

        function onStatusChanged(text) {
            statusLabel.text = text
        }

        function onSessionEnded() {
            statusLabel.text = qsTr("Sessão encerrada. PC liberado.")
            playBtn.enabled = true
            endBtn.visible = false
        }
    }
}

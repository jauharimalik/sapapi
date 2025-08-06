<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Generator QR Code Interaktif</title>
    <!-- Materialize CSS CDN -->
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/css/materialize.min.css">
    <!-- Material Icons CDN -->
    <link href="https://fonts.googleapis.com/icon?family=Material+Icons" rel="stylesheet">
    <!-- Google Fonts - Inter for modern look -->
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Inter', sans-serif;
            background-color: #f4f6f9; /* Light grey background */
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }

        .container-wrapper {
            background-color: #ffffff;
            padding: 30px;
            border-radius: 12px;
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1); /* Softer, wider shadow */
            max-width: 600px;
            width: 100%;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        h4 {
            color: #3f51b5; /* Materialize primary color */
            margin-bottom: 30px;
            font-weight: 600;
            text-align: center;
        }

        .input-field label {
            color: #3f51b5;
        }

        .input-field input[type=text]:focus + label,
        .input-field input[type=number]:focus + label {
            color: #3f51b5 !important;
        }

        .input-field input[type=text]:focus,
        .input-field input[type=number]:focus {
            border-bottom: 1px solid #3f51b5 !important;
            box-shadow: 0 1px 0 0 #3f51b5 !important;
        }

        .btn {
            background-color: #3f51b5 !important; /* Primary button color */
            margin-top: 20px;
            width: 100%; /* Full width button */
            transition: background-color 0.3s ease;
        }

        .btn:hover {
            background-color: #303f9f !important; /* Darker on hover */
        }

        #qrcode-container {
            position: relative;
            text-align: center;
            margin-top: 30px;
            padding: 20px;
            background-color: #f8f8f8; /* Slightly different background for QR */
            border-radius: 8px;
            box-shadow: 0 4px 8px rgba(0,0,0,0.08);
            display: flex;
            justify-content: center;
            align-items: center;
            min-width: 200px; /* Minimum size for QR container */
            min-height: 200px;
            overflow: hidden; /* Ensure overlay doesn't spill */
        }

        /* Adjustments for the image inside qrcode-container */
        #qrcode-container img {
            max-width: 100%; /* Ensure image fits within its container */
            height: auto; /* Maintain aspect ratio */
            display: block; /* Remove extra space below image */
        }

        .overlay-logo {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background-color: #ffffff; /* White background for logo */
            border-radius: 15px;
            padding: 8px; /* Padding around the logo */
            box-shadow: 0 2px 5px rgba(0,0,0,0.2); /* Small shadow for logo */
            z-index: 10;
            display: flex;
            justify-content: center;
            align-items: center;
            overflow: hidden;
        }

        .overlay-logo img {
            width: 60px;
            height: 60px;
            display: block;
        }

        /* Responsive adjustments */
        @media (max-width: 600px) {
            .container-wrapper {
                padding: 20px;
            }
            h4 {
                font-size: 1.8em;
            }
            .overlay-logo img {
                width: 50px;
                height: 50px;
            }
        }

        /* Print-specific styles */
        @media print {
            /* Hide the form section */
            #form-section {
                display: none !important;
            }
            /* Hide the main title */
            h4 {
                display: none !important;
            }
            /* Ensure body background is white for printing */
            body {
                background-color: #ffffff !important;
                display: block; /* Override flex for print */
                justify-content: unset;
                align-items: unset;
                min-height: unset;
                padding: 0;
            }
            /* Style the main wrapper for printing */
            .container-wrapper {
                background-color: transparent;
                box-shadow: none;
                border-radius: 0;
                margin: 0 auto; /* Center the wrapper horizontally */
                padding: 0;
                max-width: unset; /* Allow it to take full width */
                width: auto;
                display: block; /* Override flex for print */
                position: absolute; /* Position it absolutely on the print page */
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
            }
            /* Style the QR code container for printing */
            #qrcode-container {
                margin: 0; /* Remove margin from screen styles */
                padding: 0; /* Remove padding from screen styles */
                box-shadow: none;
                border-radius: 0;
                background-color: transparent;
                position: static; /* Reset positioning relative to .container-wrapper */
                top: auto;
                left: auto;
                transform: none;
                display: block !important; /* Ensure it's a block element */
            }
            #qrcode-container img { /* Target the QR code image directly */
                margin: 0 auto; /* Ensure the QR code image itself is centered */
                display: block !important; /* Ensure image is visible */
                width: auto !important; /* Allow image to print at its natural size */
                height: auto !important;
            }
            .overlay-logo {
                box-shadow: none; /* No shadow for logo on print */
                /* Keep absolute positioning for overlay within its parent (#qrcode-container) */
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
            }
        }
    </style>
</head>
<body>
    <div class="container-wrapper z-depth-1">
        <h4 class="center-align">Generator QR Code</h4>
        <div class="row" id="form-section" style="width: 100%;">
            <div class="input-field col s12">
                <i class="material-icons prefix">link</i>
                <input id="qr_data" type="text" class="validate" value="jo ganteng 12345">
                <label for="qr_data">Data QR Code</label>
            </div>
            <div class="input-field col s12">
                <i class="material-icons prefix">aspect_ratio</i>
                <input id="qr_size" type="number" class="validate" value="256" min="100" max="1024">
                <label for="qr_size">Ukuran (px)</label>
                <span class="helper-text" data-error="Ukuran tidak valid" data-success="Ok">Min 100, Max 1024</span>
            </div>
            <div class="col s12 flex-container" style="display: flex; gap: 10px;">
                <button class="btn waves-effect waves-light flex-item" id="generate_qr" style="flex: 1;">
                    Buat QR Code
                    <i class="material-icons right">qr_code</i>
                </button>
                <button class="btn waves-effect waves-light red lighten-1 flex-item" id="print_qr" style="flex: 1;">
                    Cetak QR Code
                    <i class="material-icons right">print</i>
                </button>
            </div>
        </div>
        
        <div id="qrcode-container">
            <div id="qrcode"></div>
            <!-- Logo overlay will be appended here by JS -->
        </div>
    </div>

    <!-- Materialize JavaScript CDN -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
    <!-- QRCode.js library -->
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            M.AutoInit();

            const qrDataInput = document.getElementById('qr_data');
            const qrSizeInput = document.getElementById('qr_size');
            const generateQrBtn = document.getElementById('generate_qr');
            const printQrBtn = document.getElementById('print_qr');
            const qrcodeDiv = document.getElementById('qrcode');
            const qrcodeContainer = document.getElementById('qrcode-container');
            const formSection = document.getElementById('form-section');

            let qrcodeInstance = null;

            // Function to generate QR Code
            function generateQRCode() {
                const data = qrDataInput.value;
                let size = parseInt(qrSizeInput.value, 10);

                if (isNaN(size) || size <= 0) {
                    size = 256;
                    qrSizeInput.value = 256;
                    M.toast({html: 'Ukuran tidak valid, menggunakan default 256px', classes: 'red darken-1'});
                } else if (size < 100) {
                    size = 100;
                    qrSizeInput.value = 100;
                    M.toast({html: 'Ukuran minimum adalah 100px', classes: 'red darken-1'});
                } else if (size > 1024) {
                    size = 1024;
                    qrSizeInput.value = 1024;
                    M.toast({html: 'Ukuran maksimum adalah 1024px', classes: 'red darken-1'});
                }

                // Clear previous QR code content
                qrcodeDiv.innerHTML = '';
                if (qrcodeInstance) {
                    qrcodeInstance = null; // Clear the instance
                }

                // Create a temporary div to render the QR code into (as canvas)
                const tempQrDiv = document.createElement('div');
                qrcodeDiv.appendChild(tempQrDiv); // Append temporarily to get the canvas

                // Initialize new QR Code, which will render into tempQrDiv
                qrcodeInstance = new QRCode(tempQrDiv, {
                    text: data,
                    width: size,
                    height: size,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.H
                });

                // Give a very small delay to ensure the canvas is rendered before converting
                // In most cases, this is synchronous, but a tiny delay can prevent race conditions.
                setTimeout(() => {
                    const canvas = tempQrDiv.querySelector('canvas');
                    if (canvas) {
                        const qrImage = new Image();
                        qrImage.src = canvas.toDataURL("image/png"); // Convert canvas to PNG data URL
                        qrImage.alt = "Generated QR Code";
                        qrImage.style.width = '100%'; // Ensure image scales within its container
                        qrImage.style.height = '100%';
                        qrImage.style.display = 'block';

                        // Replace the temporary div with the actual image
                        qrcodeDiv.innerHTML = ''; // Clear temp div
                        qrcodeDiv.appendChild(qrImage); // Append the image
                    } else {
                        // Fallback if canvas not found (e.g., if it rendered a table)
                        // In this case, the existing table/div structure will remain in qrcodeDiv.
                        console.warn("Canvas element not found for QR code. Printing might use table rendering.");
                    }
                }, 10); // Short delay

                qrcodeContainer.style.width = `${size + 40}px`;
                qrcodeContainer.style.height = `${size + 40}px`;

                let overlayLogo = document.querySelector('.overlay-logo');
                if (!overlayLogo) {
                    overlayLogo = document.createElement('div');
                    overlayLogo.className = 'overlay-logo';
                    overlayLogo.innerHTML = "<img src='http://app.pkserve.com:5050/pkexpress/assets/admin_lte/dist/img/pandurasa_kharisma_pt.png' alt='Logo Perusahaan'>";
                    qrcodeContainer.appendChild(overlayLogo);
                }
            }

            // Function to handle printing
            function printQRCode() {
                // Hide the form section
                formSection.style.display = 'none';
                
                // Set body background to white for printing
                document.body.style.backgroundColor = '#ffffff';

                // Give a small delay for the browser to apply display: none before printing
                setTimeout(() => {
                    window.print();
                    // Restore original display after print dialog is closed (or user cancels)
                    formSection.style.display = 'flex'; // Restore form display
                    document.body.style.backgroundColor = '#f4f6f9'; // Restore body background
                }, 100); // Small delay
            }

            // Event listeners
            generateQrBtn.addEventListener('click', generateQRCode);
            printQrBtn.addEventListener('click', printQRCode); // Add event listener for print button

            // Generate QR code on initial load with default values
            generateQRCode();
        });
    </script>
</body>
</html>

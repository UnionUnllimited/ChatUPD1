using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace UdpSample
{
    class Chat
    {
        private static IPAddress remoteIPAddress;
        private static int remotePort;
        private static int localPort;

        [STAThread]
        static void Main(string[] args)
        {
                Console.WriteLine("[Chat UPD]");

                Console.WriteLine("Укажите локальный порт");
                localPort = Convert.ToInt16(Console.ReadLine());

                Console.WriteLine("Укажите удаленный порт");
                remotePort = Convert.ToInt16(Console.ReadLine());

                Console.WriteLine("Укажите удаленный IP-адрес");
                remoteIPAddress = IPAddress.Parse(Console.ReadLine());

                Thread tRec = new Thread(new ThreadStart(Receiver));
                tRec.Start();

                while (true)
                {
                    Send(Console.ReadLine());
                }
        }

        private static void Send(string datagram)
        {
            UdpClient sender = new UdpClient();

            IPEndPoint endPoint = new IPEndPoint(remoteIPAddress, remotePort);

            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(datagram);

                sender.Send(bytes, bytes.Length, endPoint);
            }
            finally
            {
                sender.Close();
            }
        }

        public static void Receiver()
        {
            UdpClient receivingUdpClient = new UdpClient(localPort);

            IPEndPoint RemoteIpEndPoint = null;

            Console.WriteLine(
                "\n[Chat UPD] Chating");

            while (true)
            {
                byte[] receiveBytes = receivingUdpClient.Receive(
                    ref RemoteIpEndPoint);

                string returnData = Encoding.UTF8.GetString(receiveBytes);
                Console.WriteLine(" Собеседник--> " + returnData.ToString());
            }
        }
    }
}